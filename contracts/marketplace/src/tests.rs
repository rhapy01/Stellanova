//! Reconciliation tests for the NFTGram marketplace contract.
//!
//! These cover the settlement paths required before production launch:
//!   • listing lifecycle + sale settlement + cancellation
//!   • marketplace fee / creator royalty routing (payout)
//!   • offer make / accept / cancel
//!   • auction create / bid / outbid-refund / cancel / settle (with & without bids)
//!   • strict on-chain ownership checks (list / accept_offer / create_auction)
//!
//! The frontend may relax ownership validation in its offline demo sandbox,
//! but the contract itself must always enforce ownership and escrow.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};
use soroban_sdk::testutils::{Address as _, Ledger as _};

use crate::{NftGramMarketplace, NftGramMarketplaceClient};

// ---------------------------------------------------------------------------
// Mock SEP-50 NFT contract backed by per-token persistent ownership.
// It enforces the same invariants the marketplace relies on (only the owner may
// transfer / be transferred from).
// ---------------------------------------------------------------------------
#[contract]
struct MockNft;

#[derive(Clone)]
#[contracttype]
enum MockNftKey {
    Owners(u32),
    Scope(u32),
    CollectionOwner(soroban_sdk::String),
    Trait(u32, soroban_sdk::String),
    Next,
}

#[contractimpl]
impl MockNft {
    pub fn mint(env: &Env, to: Address) -> u32 {
        let next: u32 = env.storage().instance().get(&MockNftKey::Next).unwrap_or(0);
        env.storage().instance().set(&MockNftKey::Next, &(next + 1));
        env.storage().persistent().set(&MockNftKey::Owners(next), &to);
        next
    }

    pub fn mint_collection(env: &Env, to: Address, scope: soroban_sdk::String) -> u32 {
        let token_id = Self::mint(env, to.clone());
        env.storage().instance().set(&MockNftKey::Scope(token_id), &scope);
        env.storage().instance().set(&MockNftKey::CollectionOwner(scope), &to);
        token_id
    }

    pub fn owner_of(env: &Env, token_id: u32) -> Address {
        env.storage()
            .persistent()
            .get(&MockNftKey::Owners(token_id))
            .expect("missing owner")
    }

    pub fn token_scope(env: &Env, token_id: u32) -> Option<soroban_sdk::String> { env.storage().instance().get(&MockNftKey::Scope(token_id)) }
    pub fn collection_owner(env: &Env, scope: soroban_sdk::String) -> Option<Address> { env.storage().instance().get(&MockNftKey::CollectionOwner(scope)) }
    pub fn token_trait(env: &Env, token_id: u32, name: soroban_sdk::String) -> Option<soroban_sdk::String> { env.storage().instance().get(&MockNftKey::Trait(token_id, name)) }
    pub fn set_mock_trait(env: &Env, token_id: u32, name: soroban_sdk::String, value: soroban_sdk::String) { env.storage().instance().set(&MockNftKey::Trait(token_id, name), &value); }

    pub fn transfer(env: &Env, from: Address, to: Address, token_id: u32) {
        from.require_auth();
        Self::require_owner(env, &from, token_id);
        env.storage().persistent().set(&MockNftKey::Owners(token_id), &to);
    }

    pub fn transfer_from(env: &Env, spender: Address, from: Address, to: Address, token_id: u32) {
        spender.require_auth();
        Self::require_owner(env, &from, token_id);
        env.storage().persistent().set(&MockNftKey::Owners(token_id), &to);
    }

    fn require_owner(env: &Env, expect: &Address, token_id: u32) {
        let owner: Address = env
            .storage()
            .persistent()
            .get(&MockNftKey::Owners(token_id))
            .expect("missing owner");
        assert_eq!(owner, *expect, "mock nft: not the owner");
    }
}

// ---------------------------------------------------------------------------
// Harness: registers the marketplace, a real Stellar asset token, and mock nft
// ---------------------------------------------------------------------------
struct Harness {
    env: Env,
    marketplace: NftGramMarketplaceClient<'static>,
    nft: MockNftClient<'static>,
    nft_contract: Address,
    token: token::Client<'static>,
    token_contract: Address,
    _admin: Address,
    fee_recipient: Address,
    royalty_recipient: Address,
    seller: Address,
    buyer: Address,
    bidder: Address,
    second_bidder: Address,
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let royalty_recipient = Address::generate(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);
    let bidder = Address::generate(&env);
    let second_bidder = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let token = token::Client::new(&env, &token_contract);
    let token_admin = token::StellarAssetClient::new(&env, &token_contract);

    // The marketplace constructor is invoked during registration via its
    // constructor args (1% marketplace fee).
    let marketplace_contract = env.register(
        NftGramMarketplace {},
        (admin.clone(), fee_recipient.clone(), 100u32),
    );
    let marketplace = NftGramMarketplaceClient::new(&env, &marketplace_contract);

    let nft_contract = env.register(MockNft {}, ());
    let nft = MockNftClient::new(&env, &nft_contract);

    // Seed liquid balances on the token for all parties.
    for who in [&seller, &buyer, &bidder, &second_bidder, &admin] {
        token_admin.mint(who, &1_000_000);
    }

    Harness {
        env,
        marketplace,
        nft,
        nft_contract,
        token,
        token_contract,
        _admin: admin,
        fee_recipient,
        royalty_recipient,
        seller,
        buyer,
        bidder,
        second_bidder,
    }
}

fn balance(h: &Harness, who: &Address) -> i128 {
    h.token.balance(who)
}

// ---------------------------------------------------------------------------
// Listing lifecycle: list → buy settles escrow, fee and royalty
// ---------------------------------------------------------------------------
#[test]
fn listing_buy_settles_payout_fee_and_royalty() {
    let h = setup();
    // 2% creator royalty.
    h.marketplace.set_royalty(&h.royalty_recipient, &200);

    let token_id = h.nft.mint(&h.seller);
    let price: i128 = 10_000;
    let expires = h.env.ledger().sequence() + 1000;

    let listing_id = h.marketplace.list(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &price,
        &expires,
    );

    // Ownership moved to the marketplace (escrow) on list.
    assert_eq!(h.nft.owner_of(&token_id), h.marketplace.address);
    let listing = h.marketplace.get_listing(&listing_id);
    assert!(listing.active);
    assert_eq!(listing.seller, h.seller);

    let buyer_before = balance(&h, &h.buyer);
    let seller_before = balance(&h, &h.seller);
    let fee_before = balance(&h, &h.fee_recipient);
    let royalty_before = balance(&h, &h.royalty_recipient);

    h.marketplace.buy(&listing_id, &h.buyer);

    // Buyer paid the full price.
    assert_eq!(balance(&h, &h.buyer), buyer_before - price);
    // Seller receives price minus fee (1%) minus royalty (2%) = 97%.
    assert_eq!(balance(&h, &h.seller), seller_before + price * 97 / 100);
    // Fee recipient receives 1%.
    assert_eq!(balance(&h, &h.fee_recipient), fee_before + price * 1 / 100);
    // Royalty recipient receives 2%.
    assert_eq!(balance(&h, &h.royalty_recipient), royalty_before + price * 2 / 100);
    // NFT moved to the buyer and listing closed.
    assert_eq!(h.nft.owner_of(&token_id), h.buyer);
    assert!(!h.marketplace.get_listing(&listing_id).active);
}

#[test]
fn listing_cancel_returns_nft_to_seller() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;

    let listing_id = h.marketplace.list(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &5000,
        &expires,
    );
    assert_eq!(h.nft.owner_of(&token_id), h.marketplace.address);

    h.marketplace.cancel_listing(&listing_id);

    assert_eq!(h.nft.owner_of(&token_id), h.seller);
    assert!(!h.marketplace.get_listing(&listing_id).active);
}

#[test]
#[should_panic(expected = "listing is inactive")]
fn buy_inactive_listing_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;
    let listing_id = h.marketplace.list(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    h.marketplace.cancel_listing(&listing_id);
    // Second buy after cancellation must be rejected.
    h.marketplace.buy(&listing_id, &h.buyer);
}

#[test]
#[should_panic(expected = "listing expired")]
fn buy_expired_listing_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    // Listing created with a near-future expiry.
    let now = h.env.ledger().sequence();
    let expires = now + 1;
    let listing_id = h.marketplace.list(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    // Advance the ledger past the expiry, then try to buy.
    h.env.ledger().set_sequence_number(expires + 1);
    h.marketplace.buy(&listing_id, &h.buyer);
}

// ---------------------------------------------------------------------------
// Strict ownership checks on sell paths
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "seller does not own NFT")]
fn list_by_non_owner_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller); // seller owns it
    let expires = h.env.ledger().sequence() + 1000;
    // Attack: `buyer` tries to list the NFT it does not own.
    h.marketplace.list(
        &h.buyer,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
}

#[test]
#[should_panic(expected = "seller does not own NFT")]
fn accept_offer_by_non_owner_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;

    let offer_id = h.marketplace.make_offer(
        &h.buyer,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    // `bidder` (not the owner) attempts to accept the offer for the token.
    h.marketplace.accept_offer(&offer_id, &h.bidder);
}

// ---------------------------------------------------------------------------
// Self-trade / wash-trading guards
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "cannot buy own listing")]
fn seller_cannot_buy_own_listing() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;
    let listing_id = h.marketplace.list(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    // The seller tries to buy back their own listing.
    h.marketplace.buy(&listing_id, &h.seller);
}

#[test]
#[should_panic(expected = "cannot accept own offer")]
fn seller_cannot_accept_own_offer() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;
    // The seller makes an offer on their own NFT, then tries to accept it.
    let offer_id = h.marketplace.make_offer(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    h.marketplace.accept_offer(&offer_id, &h.seller);
}

#[test]
#[should_panic(expected = "cannot bid own auction")]
fn seller_cannot_bid_own_auction() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    h.env.ledger().set_sequence_number(now + 1);
    // The seller attempts to shill-bid their own auction.
    h.marketplace.bid(&auction_id, &h.seller, &2000);
}

// ---------------------------------------------------------------------------
// Offer lifecycle
// ---------------------------------------------------------------------------
#[test]
fn offer_accept_settles_to_seller() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;
    let amount: i128 = 3000;

    let buyer_before = balance(&h, &h.buyer);
    let offer_id = h.marketplace.make_offer(
        &h.buyer,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &amount,
        &expires,
    );
    // Offer escrows the buyer's funds at the marketplace.
    assert_eq!(balance(&h, &h.buyer), buyer_before - amount);

    let seller_before = balance(&h, &h.seller);
    h.marketplace.accept_offer(&offer_id, &h.seller);

    // Seller receives the offer (fee 1% only; no royalty configured here).
    assert_eq!(balance(&h, &h.seller), seller_before + amount * 99 / 100);
    // NFT to the buyer; offer closed.
    assert_eq!(h.nft.owner_of(&token_id), h.buyer);
    assert!(!h.marketplace.get_offer(&offer_id).active);
}

#[test]
fn offer_cancel_refunds_buyer() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;
    let amount: i128 = 3000;

    let buyer_before = balance(&h, &h.buyer);
    let offer_id = h.marketplace.make_offer(
        &h.buyer,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &amount,
        &expires,
    );
    assert_eq!(balance(&h, &h.buyer), buyer_before - amount);

    h.marketplace.cancel_offer(&offer_id);

    // Funds returned to the buyer; offer closed.
    assert_eq!(balance(&h, &h.buyer), buyer_before);
    assert!(!h.marketplace.get_offer(&offer_id).active);
    // NFT was never moved.
    assert_eq!(h.nft.owner_of(&token_id), h.seller);
}

#[test]
#[should_panic(expected = "offer expired")]
fn accept_expired_offer_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    // Offer created with a near-future expiry.
    let now = h.env.ledger().sequence();
    let expires = now + 1;
    let offer_id = h.marketplace.make_offer(
        &h.buyer,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    // Advance the ledger timestamp past the contract-assigned 73-hour expiry.
    let deadline = h.marketplace.get_offer(&offer_id).expires_at;
    h.env.ledger().set_timestamp((deadline + 1) as u64);
    h.marketplace.accept_offer(&offer_id, &h.seller);
}

// ---------------------------------------------------------------------------
// Auction lifecycle
// ---------------------------------------------------------------------------
#[test]
fn auction_bid_outbid_and_settle() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let reserve: i128 = 1000;

    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &reserve,
        &25,
        &(now + 1),
        &(now + 10),
    );
    // NFT escrowed on auction creation.
    assert_eq!(h.nft.owner_of(&token_id), h.marketplace.address);

    // Advance past the auction start.
    h.env.ledger().set_sequence_number(now + 1);

    let bidder_before = balance(&h, &h.bidder);
    h.marketplace.bid(&auction_id, &h.bidder, &2000);
    assert_eq!(balance(&h, &h.bidder), bidder_before - 2000);
    assert_eq!(h.marketplace.get_auction(&auction_id).highest_bid, 2000);

    // A second, higher bid refunds the previous bidder and escrows the new bid.
    let second_before = balance(&h, &h.second_bidder);
    h.marketplace.bid(&auction_id, &h.second_bidder, &3000);
    assert_eq!(balance(&h, &h.second_bidder), second_before - 3000);
    // Original bidder recovered their escrowed 2000.
    assert_eq!(balance(&h, &h.bidder), bidder_before);

    // Settle at/after the end.
    h.env.ledger().set_sequence_number(now + 10);
    let seller_before = balance(&h, &h.seller);
    h.marketplace.settle_auction(&auction_id);

    // Winner paid 3000; seller receives 99% (1% fee), buyer gets the NFT.
    assert_eq!(balance(&h, &h.second_bidder), second_before - 3000);
    assert_eq!(balance(&h, &h.seller), seller_before + 3000 * 99 / 100);
    assert_eq!(h.nft.owner_of(&token_id), h.second_bidder);
    assert!(!h.marketplace.get_auction(&auction_id).active);
}

#[test]
fn auction_settle_without_bids_returns_nft() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    h.env.ledger().set_sequence_number(now + 10);
    h.marketplace.settle_auction(&auction_id);
    // No winner → NFT returns to the seller.
    assert_eq!(h.nft.owner_of(&token_id), h.seller);
    assert!(!h.marketplace.get_auction(&auction_id).active);
}

#[test]
fn auction_cancel_without_bids_returns_nft() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    h.marketplace.cancel_auction(&auction_id);
    assert_eq!(h.nft.owner_of(&token_id), h.seller);
    assert!(!h.marketplace.get_auction(&auction_id).active);
}

#[test]
#[should_panic(expected = "auction with bids cannot be cancelled")]
fn auction_cancel_with_bids_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    h.env.ledger().set_sequence_number(now + 1);
    h.marketplace.bid(&auction_id, &h.bidder, &2000);
    // Can no longer cancel once a bid exists.
    h.marketplace.cancel_auction(&auction_id);
}

#[test]
#[should_panic(expected = "auction is not live")]
fn bid_before_auction_start_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 5),
        &(now + 10),
    );
    // Still before starts_at → reject.
    h.marketplace.bid(&auction_id, &h.bidder, &2000);
}

#[test]
#[should_panic(expected = "bid must meet reserve")]
fn bid_below_reserve_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    h.env.ledger().set_sequence_number(now + 1);
    // Bid below the 1000 reserve.
    h.marketplace.bid(&auction_id, &h.bidder, &500);
}

#[test]
#[should_panic(expected = "auction is still live")]
fn settle_before_auction_end_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    // Advance into the live window, still before the end.
    h.env.ledger().set_sequence_number(now + 5);
    h.marketplace.settle_auction(&auction_id);
}

// ---------------------------------------------------------------------------
// Minimum bid increment
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "bid must increase by minimum increment")]
fn bid_without_min_increment_panics() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    // reserve 1000, min_increment 25.
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    h.env.ledger().set_sequence_number(now + 1);
    // First bid: 2000.
    h.marketplace.bid(&auction_id, &h.bidder, &2000);
    // Second bid only raises by 20 (< 25 required).
    h.marketplace.bid(&auction_id, &h.second_bidder, &2020);
}

#[test]
fn bid_meeting_min_increment_succeeds() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    // reserve 1000, min_increment 25.
    let auction_id = h.marketplace.create_auction(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &25,
        &(now + 1),
        &(now + 10),
    );
    h.env.ledger().set_sequence_number(now + 1);
    h.marketplace.bid(&auction_id, &h.bidder, &2000);
    // Second bid raises by exactly 25 → accepted; prior bidder refunded.
    h.marketplace.bid(&auction_id, &h.second_bidder, &2025);
    assert_eq!(h.marketplace.get_auction(&auction_id).highest_bid, 2025);
    assert_eq!(h.marketplace.get_auction(&auction_id).highest_bidder, Some(h.second_bidder.clone()));
    // Outbid bidder recovered their full escrow.
    assert_eq!(balance(&h, &h.bidder), 1_000_000);
}

// ---------------------------------------------------------------------------
// Permissionless expiry reclaim (escrow cleanup)
// ---------------------------------------------------------------------------
#[test]
fn expire_listing_returns_nft_permissionlessly() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let expires = now + 1;
    let listing_id = h.marketplace.list(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    assert_eq!(h.nft.owner_of(&token_id), h.marketplace.address);

    // Advance past expiry, then a third party closes the dead escrow.
    h.env.ledger().set_sequence_number(expires + 1);
    h.marketplace.expire_listing(&listing_id);

    assert_eq!(h.nft.owner_of(&token_id), h.seller);
    assert!(!h.marketplace.get_listing(&listing_id).active);
}

#[test]
fn expire_listing_before_expiry_is_noop() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let now = h.env.ledger().sequence();
    let expires = now + 100;
    let listing_id = h.marketplace.list(
        &h.seller,
        &h.nft_contract,
        &token_id,
        &h.token_contract,
        &1000,
        &expires,
    );
    h.marketplace.expire_listing(&listing_id);
    // Still active and escrowed.
    assert_eq!(h.nft.owner_of(&token_id), h.marketplace.address);
    assert!(h.marketplace.get_listing(&listing_id).active);
}

// ---------------------------------------------------------------------------
// Admin fee / royalty guards
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "fee cannot exceed 10%")]
fn fee_over_max_panics() {
    let h = setup();
    // 50% fee is rejected.
    h.marketplace.set_fee(&h.fee_recipient, &5000);
}

#[test]
#[should_panic(expected = "royalty cannot exceed 10%")]
fn royalty_over_max_panics() {
    let h = setup();
    h.marketplace.set_royalty(&h.royalty_recipient, &5000);
}

#[test]
fn expire_offer_refunds_buyer_without_buyer_auth() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let offer_id = h.marketplace.make_offer(&h.buyer, &h.nft_contract, &token_id, &h.token_contract, &5000, &0);
    let before = balance(&h, &h.buyer);
    let expiry = h.marketplace.get_offer(&offer_id).expires_at;
    h.env.ledger().set_timestamp(expiry as u64);
    h.marketplace.expire_offer(&offer_id);
    assert_eq!(balance(&h, &h.buyer), before + 5000);
    assert!(!h.marketplace.get_offer(&offer_id).active);
}

#[test]
fn replace_offer_refunds_and_reescrows_atomically() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let before = balance(&h, &h.buyer);
    let old = h.marketplace.make_offer(&h.buyer, &h.nft_contract, &token_id, &h.token_contract, &5000, &0);
    let replacement = h.marketplace.replace_offer(&old, &h.buyer, &7000);
    assert_eq!(balance(&h, &h.buyer), before - 7000);
    assert!(!h.marketplace.get_offer(&old).active);
    assert_eq!(h.marketplace.get_offer(&replacement).amount, 7000);
    assert!(h.marketplace.get_offer(&replacement).active);
}

#[test]
fn creator_can_set_royalty_only_for_own_collection() {
    let h = setup();
    let scope = soroban_sdk::String::from_str(&h.env, "test-collection");
    let token_id = h.nft.mint_collection(&h.seller, &scope);
    h.marketplace.set_creator_royalty(&h.nft_contract, &scope, &h.seller, &h.royalty_recipient, &500);
    let expires = h.env.ledger().sequence() + 1000;
    let listing_id = h.marketplace.list(&h.seller, &h.nft_contract, &token_id, &h.token_contract, &10_000, &expires);
    let seller_before = balance(&h, &h.seller);
    let royalty_before = balance(&h, &h.royalty_recipient);
    h.marketplace.buy(&listing_id, &h.buyer);
    assert_eq!(balance(&h, &h.royalty_recipient), royalty_before + 500);
    assert_eq!(balance(&h, &h.seller), seller_before + 9_400);
}

#[test]
#[should_panic(expected = "caller is not the collection creator")]
fn non_creator_cannot_set_collection_royalty() {
    let h = setup();
    let scope = soroban_sdk::String::from_str(&h.env, "test-collection");
    h.nft.mint_collection(&h.seller, &scope);
    h.marketplace.set_creator_royalty(&h.nft_contract, &scope, &h.buyer, &h.buyer, &500);
}

#[test]
fn seller_can_edit_listing_price_without_releasing_escrow() {
    let h = setup();
    let token_id = h.nft.mint(&h.seller);
    let expires = h.env.ledger().sequence() + 1000;
    let listing_id = h.marketplace.list(&h.seller, &h.nft_contract, &token_id, &h.token_contract, &1000, &expires);
    h.marketplace.update_listing(&listing_id, &h.token_contract, &2000, &(expires + 1000));
    let listing = h.marketplace.get_listing(&listing_id);
    assert_eq!(listing.price, 2000);
    assert!(listing.active);
    assert_eq!(h.nft.owner_of(&token_id), h.marketplace.address);
}

#[test]
fn collection_offer_accepts_only_token_in_scope_and_settles() {
    let h = setup();
    let scope = soroban_sdk::String::from_str(&h.env, "collection-a");
    let token_id = h.nft.mint_collection(&h.seller, &scope);
    let before = balance(&h, &h.buyer);
    let offer_id = h.marketplace.make_collection_offer(&h.buyer, &h.nft_contract, &scope, &h.token_contract, &5000);
    assert_eq!(balance(&h, &h.buyer), before - 5000);
    h.marketplace.accept_collection_offer(&offer_id, &h.seller, &token_id);
    assert_eq!(h.nft.owner_of(&token_id), h.buyer);
    assert!(!h.marketplace.get_collection_offer(&offer_id).active);
}

#[test]
fn expired_collection_offer_refunds_permissionlessly() {
    let h = setup();
    let scope = soroban_sdk::String::from_str(&h.env, "collection-a");
    let before = balance(&h, &h.buyer);
    let offer_id = h.marketplace.make_collection_offer(&h.buyer, &h.nft_contract, &scope, &h.token_contract, &5000);
    let expiry = h.marketplace.get_collection_offer(&offer_id).expires_at;
    h.env.ledger().set_timestamp(expiry as u64);
    h.marketplace.expire_collection_offer(&offer_id);
    assert_eq!(balance(&h, &h.buyer), before);
    assert!(!h.marketplace.get_collection_offer(&offer_id).active);
}

#[test]
fn trait_offer_acceptance_checks_scope_and_committed_trait_then_settles() {
    let h = setup();
    let scope = soroban_sdk::String::from_str(&h.env, "trait-set");
    let token_id = h.nft.mint_collection(&h.seller, &scope);
    let trait_type = soroban_sdk::String::from_str(&h.env, "Eyes");
    let trait_value = soroban_sdk::String::from_str(&h.env, "Calm");
    h.nft.set_mock_trait(&token_id, &trait_type, &trait_value);
    token::StellarAssetClient::new(&h.env, &h.token_contract).mint(&h.buyer, &10_000);
    let buyer_before = h.token.balance(&h.buyer);
    let seller_before = h.token.balance(&h.seller);
    let offer_id = h.marketplace.make_trait_offer(&h.buyer, &h.nft_contract, &scope, &trait_type, &trait_value, &h.token_contract, &5_000);
    h.marketplace.accept_trait_offer(&offer_id, &h.seller, &token_id);
    assert_eq!(h.nft.owner_of(&token_id), h.buyer);
    assert_eq!(h.token.balance(&h.buyer), buyer_before - 5_000);
    assert_eq!(h.token.balance(&h.seller), seller_before + 4_950);
    assert!(!h.marketplace.get_trait_offer(&offer_id).active);
}

#[test]
#[should_panic(expected = "token does not match offered trait")]
fn trait_offer_cannot_be_accepted_by_nonmatching_nft() {
    let h = setup();
    let scope = soroban_sdk::String::from_str(&h.env, "trait-set");
    let token_id = h.nft.mint_collection(&h.seller, &scope);
    let trait_type = soroban_sdk::String::from_str(&h.env, "Eyes");
    h.nft.set_mock_trait(&token_id, &trait_type, &soroban_sdk::String::from_str(&h.env, "Angry"));
    token::StellarAssetClient::new(&h.env, &h.token_contract).mint(&h.buyer, &10_000);
    let offer_id = h.marketplace.make_trait_offer(&h.buyer, &h.nft_contract, &scope, &trait_type, &soroban_sdk::String::from_str(&h.env, "Calm"), &h.token_contract, &5_000);
    h.marketplace.accept_trait_offer(&offer_id, &h.seller, &token_id);
}
