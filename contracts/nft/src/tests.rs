use soroban_sdk::{testutils::{Address as _, Ledger as _}, Address, Env, String, Symbol};

use crate::{NftDrop, NftDropClient};

struct Harness {
    env: Env,
    nft: NftDropClient<'static>,
    admin: Address,
    creator: Address,
    buyer: Address,
    other: Address,
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let buyer = Address::generate(&env);
    let other = Address::generate(&env);
    let contract = env.register(
        NftDrop {},
        (
            String::from_str(&env, "ipfs://base/"),
            String::from_str(&env, "Test Collection"),
            String::from_str(&env, "TEST"),
            admin.clone(),
        ),
    );
    let nft = NftDropClient::new(&env, &contract);
    Harness { env, nft, admin, creator, buyer, other }
}

#[test]
fn constructor_sets_collection_metadata_and_starts_unrevealed() {
    let h = setup();

    assert_eq!(h.nft.admin(), h.admin);
    assert_eq!(h.nft.name(), String::from_str(&h.env, "Test Collection"));
    assert_eq!(h.nft.symbol(), String::from_str(&h.env, "TEST"));
    assert_eq!(h.nft.decimals(), 0);
    assert!(!h.nft.revealed());
    assert_eq!(h.nft.stage_count(), 0);
}

#[test]
fn unrevealed_creator_mints_keep_placeholder_until_creator_reveals_metadata() {
    let h = setup();
    let scope = String::from_str(&h.env, "test-collection");
    let placeholder = String::from_str(&h.env, "ipfs://placeholder/hidden.json");
    h.nft.set_creator_reveal(&h.creator, &scope, &false, &placeholder);

    let token_id = h.nft.mint_with_metadata(
        &h.creator,
        &scope,
        &placeholder,
    );
    assert_eq!(token_id, 0);
    assert_eq!(h.nft.owner_of(&token_id), h.creator);
    assert_eq!(h.nft.token_uri(&token_id), placeholder.to_bytes());
    assert_eq!(h.nft.collection_token_ids(&scope, &0, &10), soroban_sdk::vec![&h.env, 0u32]);

    h.nft.set_creator_reveal(&h.creator, &scope, &true, &String::from_str(&h.env, ""));
    h.nft.set_creator_token_uris(
        &h.creator,
        &scope,
        &soroban_sdk::vec![&h.env, 0u32],
        &soroban_sdk::vec![&h.env, String::from_str(&h.env, "ipfs://metadata/0.json")],
    );
    assert_eq!(h.nft.token_uri(&token_id), String::from_str(&h.env, "ipfs://metadata/0.json").to_bytes());
}

#[test]
#[should_panic(expected = "collection belongs to another creator")]
fn another_creator_cannot_mint_into_an_owned_collection() {
    let h = setup();
    let scope = String::from_str(&h.env, "owned-collection");
    h.nft.mint_with_metadata(&h.creator, &scope, &String::from_str(&h.env, "ipfs://one"));
    h.nft.mint_with_metadata(&h.other, &scope, &String::from_str(&h.env, "ipfs://two"));
}

fn configure_public_stage(h: &Harness, scope: &String, supply: u32, wallet_limit: u32) {
    h.env.ledger().with_mut(|ledger| ledger.timestamp = 100);
    h.nft.set_creator_stage(
        &h.creator,
        &1,
        &Symbol::new(&h.env, "public"),
        &90,
        &200,
        &0,
        &wallet_limit,
        &supply,
        &0,
        scope,
        &String::from_str(&h.env, "ipfs://edition/"),
        &supply,
    );
}

#[test]
fn stage_batch_mint_assigns_distinct_ids_and_tracks_owners_and_edition_uri() {
    let h = setup();
    let scope = String::from_str(&h.env, "stage-collection");
    configure_public_stage(&h, &scope, 5, 5);

    let (edition_start, token_ids) = h.nft.mint_from_stage(&1, &h.buyer, &3);
    assert_eq!(edition_start, 0);
    assert_eq!(token_ids, soroban_sdk::vec![&h.env, 0u32, 1u32, 2u32]);
    for id in 0..3u32 {
        assert_eq!(h.nft.owner_of(&id), h.buyer);
        let expected_uri = match id {
            0 => "ipfs://edition/0.json",
            1 => "ipfs://edition/1.json",
            _ => "ipfs://edition/2.json",
        };
        assert_eq!(h.nft.token_uri(&id), String::from_str(&h.env, expected_uri).to_bytes());
    }
    assert_eq!(h.nft.collection_token_ids(&scope, &0, &10), token_ids);
    assert_eq!(h.nft.collection_token_ids(&scope, &2, &10), soroban_sdk::vec![&h.env, 2u32]);
}

#[test]
#[should_panic(expected = "per-wallet mint limit exceeded")]
fn stage_rejects_quantity_above_wallet_limit() {
    let h = setup();
    let scope = String::from_str(&h.env, "limited-collection");
    configure_public_stage(&h, &scope, 10, 2);
    h.nft.mint_from_stage(&1, &h.buyer, &3);
}

#[test]
#[should_panic(expected = "stage supply exhausted")]
fn stage_rejects_batch_that_exceeds_remaining_supply() {
    let h = setup();
    let scope = String::from_str(&h.env, "supply-limited-collection");
    configure_public_stage(&h, &scope, 3, 5);
    h.nft.mint_from_stage(&1, &h.buyer, &2);
    h.nft.mint_from_stage(&1, &h.other, &2);
}

#[test]
fn transfer_changes_owner_increments_nonces_and_clears_approval() {
    let h = setup();
    let token_id = h.nft.mint(&h.creator);
    h.nft.set_approved(&h.creator, &h.other, &token_id, &true);
    assert_eq!(h.nft.get_approved(&token_id), Some(h.other.clone()));

    h.nft.transfer(&h.creator, &h.buyer, &token_id);
    assert_eq!(h.nft.owner_of(&token_id), h.buyer);
    assert_eq!(h.nft.get_approved(&token_id), None);
    assert_eq!(h.nft.nonce(&h.creator), 1);
    assert_eq!(h.nft.nonce(&h.buyer), 1);
}

#[test]
#[should_panic(expected = "not the owner")]
fn non_owner_cannot_transfer_token() {
    let h = setup();
    let token_id = h.nft.mint(&h.creator);
    h.nft.transfer(&h.other, &h.buyer, &token_id);
}
