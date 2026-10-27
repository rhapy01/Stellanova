#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Bytes, Env, String, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// NFTGram SEP-50 NFT with on-chain drop stages (allowlists, FCFS / guaranteed /
// team / public) and reveal / unreveal.
//
// Implements the SEP-50 non-fungible interface expected by the marketplace
// contract (transfer, transfer_from, owner_of) plus a full NFT surface.
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[contracttype]
pub struct Allowance {
    pub spender: Address,
    pub live_until_ledger: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct TokenMetadata {
    pub token_uri: Bytes,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
}

/// A single mint stage. `kind` is a short string label:
/// "team" / "guaranteed" / "fcfs" / "public".
#[derive(Clone)]
#[contracttype]
pub struct DropStage {
    pub kind: Symbol,
    pub start_time: u64,
    pub end_time: u64,
    pub price: i128,
    pub per_wallet_limit: u32,
    pub max_supply: u32,
    pub seq: u32,
}

/// Per-wallet allowlist entry for a stage. `custom_limit` overrides the stage
/// per-wallet limit; `custom_price` overrides the stage price.
#[derive(Clone)]
#[contracttype]
pub struct AllowListEntry {
    pub allowed: bool,
    pub custom_limit: Option<u32>,
    pub custom_price: Option<i128>,
    pub minted: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    NextTokenId,
    TokenOwner(u32),
    TokenApproved(u32),
    Metadata,
    Revealed,
    Stage(u32),
    StageOwner(u32),
    StageScope(u32),
    StageMetadata(u32),
    StageEditionCount(u32),
    StageCount,
    PublicStageFor(String),
    TokenUri(u32),
    TokenScope(u32),
    TokenTrait(u32, String),
    TokenTraitsRegistered(u32),
    TokenTraitCount(u32),
    CollectionOwner(String),
    CollectionRevealed(String),
    CollectionPlaceholder(String),
    CollectionRevealConfigured(String),
    EverPublicMetadata(String),
    CollectionToken(String, u32),
    CollectionTokenCount(String),
    AllowList(u32, Address),
    StageMinted(u32),
    /// Per-wallet public-stage mint count (stage_id, wallet) -> u32
    PublicStageMint(u32, Address),
    PaymentToken,
    Nonce(Address),
}

#[contract]
pub struct NftDrop;

#[contractimpl]
impl NftDrop {
    // ---- Constructor ----
    pub fn __constructor(env: &Env, uri: String, name: String, symbol: String, owner: Address) {
        owner.require_auth();
        env.storage().instance().set(&DataKey::Admin, &owner);
        env.storage().instance().set(&DataKey::NextTokenId, &0u32);
        env.storage().instance().set(&DataKey::StageCount, &0u32);
        env.storage().instance().set(&DataKey::Revealed, &false);
        let metadata = TokenMetadata {
            token_uri: uri.to_bytes(),
            name,
            symbol,
            decimals: 0,
        };
        env.storage().instance().set(&DataKey::Metadata, &metadata);
        // Payment token is unset by default; the admin must call set_payment_token
        // (e.g. with the native XLM token) before stage mints can collect proceeds.
    }

    pub fn admin(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    // ---- Metadata (SEP-50) ----
    pub fn name(env: &Env) -> String {
        env.storage().instance().get::<_, TokenMetadata>(&DataKey::Metadata).unwrap().name
    }
    pub fn symbol(env: &Env) -> String {
        env.storage().instance().get::<_, TokenMetadata>(&DataKey::Metadata).unwrap().symbol
    }
    pub fn decimals(env: &Env) -> u32 {
        env.storage().instance().get::<_, TokenMetadata>(&DataKey::Metadata).unwrap().decimals
    }
    pub fn metadata(env: &Env) -> TokenMetadata {
        env.storage().instance().get::<_, TokenMetadata>(&DataKey::Metadata).unwrap()
    }

    /// token_uri returns the placeholder URI until the collection is revealed,
    /// then the real per-token URI.
    pub fn token_uri(env: &Env, token_id: u32) -> Bytes {
        if let Some(scope) = env.storage().instance().get::<_, String>(&DataKey::TokenScope(token_id)) {
            let revealed = env.storage().instance().get::<_, bool>(&DataKey::CollectionRevealed(scope.clone())).unwrap_or(true);
            if !revealed {
                if let Some(placeholder) = env.storage().instance().get::<_, Bytes>(&DataKey::CollectionPlaceholder(scope)) {
                    return placeholder;
                }
            }
        }
        if let Some(uri) = env.storage().instance().get::<_, Bytes>(&DataKey::TokenUri(token_id)) {
            return uri;
        }
        let meta = env.storage().instance().get::<_, TokenMetadata>(&DataKey::Metadata).unwrap();
        let revealed: bool = env.storage().instance().get(&DataKey::Revealed).unwrap_or(false);
        if revealed {
            token_uri_for(env, &meta, token_id)
        } else {
            meta.token_uri.clone()
        }
    }

    /// Paginated token enumeration for a collection, used by the creator reveal flow.
    pub fn collection_token_ids(env: &Env, scope: String, start: u32, limit: u32) -> Vec<u32> {
        if limit == 0 || limit > 100 { panic!("token enumeration page size must be 1 to 100"); }
        let count = env.storage().instance().get::<_, u32>(&DataKey::CollectionTokenCount(scope.clone())).unwrap_or(0);
        let end = core::cmp::min(start.saturating_add(limit), count);
        let mut ids = Vec::new(env);
        for index in start..end {
            if let Some(token_id) = env.storage().instance().get::<_, u32>(&DataKey::CollectionToken(scope.clone(), index)) {
                ids.push_back(token_id);
            }
        }
        ids
    }

    // ---- Reveal / unreveal ----
    pub fn revealed(env: &Env) -> bool {
        env.storage().instance().get(&DataKey::Revealed).unwrap_or(false)
    }
    pub fn set_revealed(env: &Env, revealed: bool) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Revealed, &revealed);
        env.events().publish((Symbol::new(env, "reveal"),), revealed);
    }

    /// Configure collection-scoped reveal state and a shared placeholder URI.
    pub fn set_creator_reveal(env: &Env, creator: Address, scope: String, revealed: bool, placeholder_uri: String) {
        creator.require_auth();
        if scope.is_empty() || (!revealed && placeholder_uri.is_empty()) {
            panic!("collection scope and unrevealed placeholder are required");
        }
        let owner = env.storage().instance().get::<_, Address>(&DataKey::CollectionOwner(scope.clone()));
        if let Some(owner) = owner {
            if owner != creator { panic!("only the collection creator can change reveal state"); }
        } else {
            env.storage().instance().set(&DataKey::CollectionOwner(scope.clone()), &creator);
        }
        let was_configured = env.storage().instance().get::<_, bool>(&DataKey::CollectionRevealConfigured(scope.clone())).unwrap_or(false);
        let was_revealed = env.storage().instance().get::<_, bool>(&DataKey::CollectionRevealed(scope.clone())).unwrap_or(true);
        if was_configured && was_revealed && !revealed {
            panic!("a revealed collection cannot be hidden again");
        }
        if !revealed && env.storage().instance().get::<_, bool>(&DataKey::EverPublicMetadata(scope.clone())).unwrap_or(false) {
            panic!("hide the collection before publishing any mint or stage metadata on-chain");
        }
        if !placeholder_uri.is_empty() {
            env.storage().instance().set(&DataKey::CollectionPlaceholder(scope.clone()), &placeholder_uri.to_bytes());
        }
        env.storage().instance().set(&DataKey::CollectionRevealed(scope.clone()), &revealed);
        env.storage().instance().set(&DataKey::CollectionRevealConfigured(scope.clone()), &true);
        env.events().publish((Symbol::new(env, "collection_reveal"), scope), revealed);
    }

    /// Publish the real metadata URIs only after reveal. Calls are intentionally
    /// bounded so creators can reveal large collections in manageable batches.
    pub fn set_creator_token_uris(env: &Env, creator: Address, scope: String, token_ids: Vec<u32>, metadata_uris: Vec<String>) {
        creator.require_auth();
        if token_ids.is_empty() || token_ids.len() > 20 || token_ids.len() != metadata_uris.len() {
            panic!("metadata URI batches must contain 1 to 20 matching tokens and URIs");
        }
        if !env.storage().instance().get::<_, bool>(&DataKey::CollectionRevealed(scope.clone())).unwrap_or(true) {
            panic!("collection must be revealed before publishing token metadata");
        }
        let owner: Address = env.storage().instance().get(&DataKey::CollectionOwner(scope.clone())).unwrap();
        if owner != creator { panic!("only the collection creator can publish token metadata"); }
        for index in 0..token_ids.len() {
            let token_id = token_ids.get(index).unwrap();
            let uri = metadata_uris.get(index).unwrap();
            if uri.is_empty() { panic!("metadata URI cannot be empty"); }
            let token_scope: String = env.storage().instance().get(&DataKey::TokenScope(token_id)).unwrap();
            if token_scope != scope { panic!("token does not belong to this collection"); }
            env.storage().instance().set(&DataKey::TokenUri(token_id), &uri.to_bytes());
        }
    }

    // ---- Ownership ----
    pub fn owner_of(env: &Env, token_id: u32) -> Address {
        env.storage().instance().get(&DataKey::TokenOwner(token_id)).unwrap()
    }

    /// Public collection provenance for marketplace royalty verification.
    pub fn token_scope(env: &Env, token_id: u32) -> Option<String> {
        env.storage().instance().get(&DataKey::TokenScope(token_id))
    }

    /// Public creator identity for a collection scope.
    pub fn collection_owner(env: &Env, scope: String) -> Option<Address> {
        env.storage().instance().get(&DataKey::CollectionOwner(scope))
    }

    /// The collection creator commits canonical traits once per token. These
    /// on-chain values let trait offers match artwork without trusting UI text.
    pub fn set_token_traits(env: &Env, creator: Address, token_id: u32, names: Vec<String>, values: Vec<String>) {
        creator.require_auth();
        if names.is_empty() || names.len() > 50 || names.len() != values.len() { panic!("trait batches must contain 1 to 50 matching names and values"); }
        let scope: String = env.storage().instance().get(&DataKey::TokenScope(token_id)).unwrap_or_else(|| panic!("token has no collection scope"));
        let owner: Address = env.storage().instance().get(&DataKey::CollectionOwner(scope)).unwrap_or_else(|| panic!("collection creator is not registered"));
        if owner != creator { panic!("only the collection creator can register token traits"); }
        let already_registered = env.storage().instance().get::<_, bool>(&DataKey::TokenTraitsRegistered(token_id)).unwrap_or(false);
        if already_registered && env.storage().instance().get::<_, u32>(&DataKey::TokenTraitCount(token_id)).unwrap_or(0) != names.len() { panic!("registered token traits cannot be changed"); }
        for index in 0..names.len() {
            let name = names.get(index).unwrap();
            let value = values.get(index).unwrap();
            if name.is_empty() || value.is_empty() { panic!("trait names and values cannot be empty"); }
            for other in index + 1..names.len() { if names.get(other).unwrap() == name { panic!("duplicate trait category"); } }
            let key = DataKey::TokenTrait(token_id, name.clone());
            if already_registered {
                let existing: Option<String> = env.storage().instance().get(&key);
                if existing != Some(value) { panic!("registered token traits cannot be changed"); }
            } else {
                env.storage().instance().set(&key, &value);
            }
        }
        if !already_registered {
            env.storage().instance().set(&DataKey::TokenTraitCount(token_id), &names.len());
            env.storage().instance().set(&DataKey::TokenTraitsRegistered(token_id), &true);
        }
    }

    pub fn token_trait(env: &Env, token_id: u32, name: String) -> Option<String> {
        env.storage().instance().get(&DataKey::TokenTrait(token_id, name))
    }

    pub fn token_traits_registered(env: &Env, token_id: u32) -> bool {
        env.storage().instance().get(&DataKey::TokenTraitsRegistered(token_id)).unwrap_or(false)
    }

    // ---- Permissionless mint (admin only on-chain) ----
    pub fn mint(env: &Env, to: Address) -> u32 {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let token_id = env.storage().instance().get::<_, u32>(&DataKey::NextTokenId).unwrap_or(0);
        do_mint(env, &to, token_id);
        env.storage().instance().set(&DataKey::NextTokenId, &(token_id + 1));
        token_id
    }

    /// Creator-authorized one-off mint with immutable, per-token metadata.
    pub fn mint_with_metadata(env: &Env, to: Address, collection_scope: String, metadata_uri: String) -> u32 {
        to.require_auth();
        if metadata_uri.is_empty() || collection_scope.is_empty() {
            panic!("collection scope and metadata URI are required");
        }
        let owner = env.storage().instance().get::<_, Address>(&DataKey::CollectionOwner(collection_scope.clone()));
        if let Some(owner) = owner { if owner != to { panic!("collection belongs to another creator"); } }
        else { env.storage().instance().set(&DataKey::CollectionOwner(collection_scope.clone()), &to); }
        let token_id = env.storage().instance().get::<_, u32>(&DataKey::NextTokenId).unwrap_or(0);
        let revealed = env.storage().instance().get::<_, bool>(&DataKey::CollectionRevealed(collection_scope.clone())).unwrap_or(true);
        let token_uri = if revealed { metadata_uri.to_bytes() } else {
            env.storage().instance().get::<_, Bytes>(&DataKey::CollectionPlaceholder(collection_scope.clone())).unwrap_or_else(|| panic!("configure an unrevealed placeholder before minting"))
        };
        if revealed { env.storage().instance().set(&DataKey::EverPublicMetadata(collection_scope.clone()), &true); }
        if !revealed {
            let placeholder = env.storage().instance().get::<_, Bytes>(&DataKey::CollectionPlaceholder(collection_scope.clone())).unwrap_or_else(|| panic!("configure an unrevealed placeholder before minting"));
            if metadata_uri.to_bytes() != placeholder { panic!("unrevealed mint calls must use the placeholder URI"); }
        }
        env.storage().instance().set(&DataKey::TokenUri(token_id), &token_uri);
        env.storage().instance().set(&DataKey::TokenScope(token_id), &collection_scope);
        track_collection_token(env, &collection_scope, token_id);
        do_mint(env, &to, token_id);
        env.storage().instance().set(&DataKey::NextTokenId, &(token_id + 1));
        token_id
    }

    /// A creator configures a stage on-chain. The creator wallet owns its
    /// stage, so platform admin keys are not needed for creator operations.
    pub fn set_creator_stage(
        env: &Env,
        creator: Address,
        stage_id: u32,
        kind: Symbol,
        start_time: u64,
        end_time: u64,
        price: i128,
        per_wallet_limit: u32,
        max_supply: u32,
        seq: u32,
        collection_scope: String,
        metadata_uri: String,
        edition_count: u32,
    ) {
        creator.require_auth();
        if end_time <= start_time || per_wallet_limit == 0 || metadata_uri.is_empty() || collection_scope.is_empty() || edition_count == 0 {
            panic!("invalid stage configuration");
        }
        let collection_owner = env.storage().instance().get::<_, Address>(&DataKey::CollectionOwner(collection_scope.clone()));
        if let Some(owner) = collection_owner { if owner != creator { panic!("collection belongs to another creator"); } }
        else { env.storage().instance().set(&DataKey::CollectionOwner(collection_scope.clone()), &creator); }
        let existing_owner = env.storage().instance().get::<_, Address>(&DataKey::StageOwner(stage_id));
        if let Some(owner) = existing_owner {
            if owner != creator {
                panic!("stage belongs to another creator");
            }
            if let Some(existing_stage) = env.storage().instance().get::<_, DropStage>(&DataKey::Stage(stage_id)) {
                if existing_stage.kind != kind {
                    panic!("stage kind cannot be changed");
                }
            }
            if env.storage().instance().get::<_, u32>(&DataKey::StageMinted(stage_id)).unwrap_or(0) > 0 {
                panic!("a stage cannot be changed after minting starts");
            }
        } else {
            let count = env.storage().instance().get::<_, u32>(&DataKey::StageCount).unwrap_or(0);
            env.storage().instance().set(&DataKey::StageCount, &(count + 1));
            env.storage().instance().set(&DataKey::StageOwner(stage_id), &creator);
        }
        if kind != Symbol::new(env, "public")
            && env.storage().instance().get::<_, u32>(&DataKey::PublicStageFor(collection_scope.clone())).is_some()
        {
            panic!("presale stages must precede the public stage");
        }
        if kind == Symbol::new(env, "public") {
            if let Some(public_stage) = env.storage().instance().get::<_, u32>(&DataKey::PublicStageFor(collection_scope.clone())) {
                if public_stage != stage_id {
                    panic!("only one public stage is allowed");
                }
            }
            env.storage().instance().set(&DataKey::PublicStageFor(collection_scope.clone()), &stage_id);
        }
        let stage = DropStage { kind, start_time, end_time, price, per_wallet_limit, max_supply, seq };
        env.storage().instance().set(&DataKey::Stage(stage_id), &stage);
        env.storage().instance().set(&DataKey::StageScope(stage_id), &collection_scope);
        let revealed = env.storage().instance().get::<_, bool>(&DataKey::CollectionRevealed(collection_scope.clone())).unwrap_or(true);
        let stage_uri = if revealed { env.storage().instance().set(&DataKey::EverPublicMetadata(collection_scope.clone()), &true); metadata_uri.to_bytes() } else {
            let placeholder = env.storage().instance().get::<_, Bytes>(&DataKey::CollectionPlaceholder(collection_scope.clone())).unwrap_or_else(|| panic!("configure an unrevealed placeholder before creating stages"));
            if metadata_uri.to_bytes() != placeholder { panic!("unrevealed stage calls must use the placeholder URI"); }
            placeholder
        };
        env.storage().instance().set(&DataKey::StageMetadata(stage_id), &stage_uri);
        env.storage().instance().set(&DataKey::StageEditionCount(stage_id), &edition_count);
        env.events().publish((Symbol::new(env, "stage"), stage_id), stage);
    }

    pub fn remove_creator_stage(env: &Env, creator: Address, stage_id: u32) {
        creator.require_auth();
        let owner: Address = env.storage().instance().get(&DataKey::StageOwner(stage_id)).unwrap();
        if owner != creator {
            panic!("only the stage creator can remove it");
        }
        let stage: DropStage = env.storage().instance().get(&DataKey::Stage(stage_id)).unwrap();
        if stage.kind == Symbol::new(env, "public") {
            panic!("public stage cannot be removed");
        }
        if env.storage().instance().get::<_, u32>(&DataKey::StageMinted(stage_id)).unwrap_or(0) > 0 {
            panic!("a stage cannot be removed after minting starts");
        }
        env.storage().instance().remove(&DataKey::Stage(stage_id));
        env.storage().instance().remove(&DataKey::StageOwner(stage_id));
        if let Some(scope) = env.storage().instance().get::<_, String>(&DataKey::StageScope(stage_id)) {
            let public_stage = env.storage().instance().get::<_, u32>(&DataKey::PublicStageFor(scope.clone()));
            if public_stage == Some(stage_id) {
                env.storage().instance().remove(&DataKey::PublicStageFor(scope));
            }
        }
        env.storage().instance().remove(&DataKey::StageScope(stage_id));
        env.storage().instance().remove(&DataKey::StageMetadata(stage_id));
        env.storage().instance().remove(&DataKey::StageEditionCount(stage_id));
        env.storage().instance().remove(&DataKey::StageMinted(stage_id));
        let count = env.storage().instance().get::<_, u32>(&DataKey::StageCount).unwrap_or(0);
        env.storage().instance().set(&DataKey::StageCount, &count.saturating_sub(1));
    }

    pub fn whitelist_creator_wallet(
        env: &Env,
        creator: Address,
        stage_id: u32,
        wallet: Address,
        allowed: bool,
        custom_limit: Option<u32>,
        custom_price: Option<i128>,
    ) {
        creator.require_auth();
        let owner: Address = env.storage().instance().get(&DataKey::StageOwner(stage_id)).unwrap();
        if owner != creator {
            panic!("only the stage creator can edit its allowlist");
        }
        let stage: DropStage = env.storage().instance().get(&DataKey::Stage(stage_id)).unwrap();
        if stage.kind == Symbol::new(env, "public") {
            panic!("public stage has no allowlist");
        }
        let minted = env.storage().instance().get::<_, AllowListEntry>(&DataKey::AllowList(stage_id, wallet.clone())).map(|entry| entry.minted).unwrap_or(0);
        if !allowed && minted == 0 {
            env.storage().instance().remove(&DataKey::AllowList(stage_id, wallet.clone()));
        } else {
            env.storage().instance().set(&DataKey::AllowList(stage_id, wallet.clone()), &AllowListEntry { allowed, custom_limit, custom_price, minted });
        }
        env.events().publish((Symbol::new(env, "whitelist"), stage_id, wallet), allowed);
    }

    // ---- Drop stages (admin) ----
    pub fn stage_count(env: &Env) -> u32 {
        env.storage().instance().get(&DataKey::StageCount).unwrap_or(0)
    }
    pub fn get_stage(env: &Env, stage_id: u32) -> DropStage {
        env.storage().instance().get(&DataKey::Stage(stage_id)).unwrap()
    }

    /// Admin creates or replaces a stage. Exactly one public stage is allowed.
    pub fn set_stage(
        env: &Env,
        stage_id: u32,
        kind: Symbol,
        start_time: u64,
        end_time: u64,
        price: i128,
        per_wallet_limit: u32,
        max_supply: u32,
        seq: u32,
    ) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if end_time <= start_time {
            panic!("stage end must be after start");
        }
        if kind == Symbol::new(env, "public") {
            let count = env.storage().instance().get::<_, u32>(&DataKey::StageCount).unwrap_or(0);
            for i in 0..count {
                if i != stage_id {
                    if let Some(s) = env.storage().instance().get::<_, DropStage>(&DataKey::Stage(i)) {
                        if s.kind == Symbol::new(env, "public") {
                            panic!("only one public stage allowed");
                        }
                    }
                }
            }
        }
        let stage = DropStage {
            kind,
            start_time,
            end_time,
            price,
            per_wallet_limit,
            max_supply,
            seq,
        };
        if env.storage().instance().get::<_, DropStage>(&DataKey::Stage(stage_id)).is_none() {
            let count = env.storage().instance().get::<_, u32>(&DataKey::StageCount).unwrap_or(0);
            env.storage().instance().set(&DataKey::StageCount, &(count + 1));
        }
        env.storage().instance().set(&DataKey::Stage(stage_id), &stage);
        env.events().publish((Symbol::new(env, "stage"), stage_id), stage.clone());
    }

    pub fn remove_stage(env: &Env, stage_id: u32) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let stage: DropStage = env.storage().instance().get(&DataKey::Stage(stage_id)).unwrap();
        if stage.kind == Symbol::new(env, "public") {
            panic!("public stage cannot be removed");
        }
        env.storage().instance().remove(&DataKey::Stage(stage_id));
        env.storage().instance().remove(&DataKey::StageMinted(stage_id));
        let count = env.storage().instance().get::<_, u32>(&DataKey::StageCount).unwrap_or(0);
        env.storage().instance().set(&DataKey::StageCount, &count.saturating_sub(1));
    }

    // ---- Allowlist (admin) ----
    pub fn whitelist_wallet(
        env: &Env,
        stage_id: u32,
        wallet: Address,
        allowed: bool,
        custom_limit: Option<u32>,
        custom_price: Option<i128>,
    ) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let stage: DropStage = env.storage().instance().get(&DataKey::Stage(stage_id)).unwrap();
        if stage.kind == Symbol::new(env, "public") {
            panic!("public stage has no allowlist");
        }
        let minted = env
            .storage()
            .instance()
            .get::<_, AllowListEntry>(&DataKey::AllowList(stage_id, wallet.clone()))
            .map(|e| e.minted)
            .unwrap_or(0);
        if !allowed && minted == 0 {
            env.storage().instance().remove(&DataKey::AllowList(stage_id, wallet.clone()));
        } else {
            env.storage().instance().set(
                &DataKey::AllowList(stage_id, wallet.clone()),
                &AllowListEntry { allowed, custom_limit, custom_price, minted },
            );
        }
        env.events().publish((Symbol::new(env, "whitelist"), stage_id, wallet), allowed);
    }

    pub fn allowlist_entry(env: &Env, stage_id: u32, wallet: Address) -> Option<AllowListEntry> {
        env.storage().instance().get(&DataKey::AllowList(stage_id, wallet))
    }

    // ---- Payment token (admin) ----
    pub fn payment_token(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::PaymentToken).unwrap()
    }
    pub fn set_payment_token(env: &Env, payment_token: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::PaymentToken, &payment_token);
    }

    // ---- On-chain stage mint (drop gating) ----
    /// Mint from a specific stage, enforcing the time window, allowlist (or
    /// public openness), per-wallet limit, stage supply, and payment.
    pub fn mint_from_stage(env: &Env, stage_id: u32, to: Address, quantity: u32) -> (u32, Vec<u32>) {
        to.require_auth();
        if quantity == 0 {
            panic!("quantity must be positive");
        }
        let stage: DropStage = env.storage().instance().get(&DataKey::Stage(stage_id)).unwrap();
        let now = env.ledger().timestamp();
        if now < stage.start_time || now > stage.end_time {
            panic!("stage is not active");
        }

        let is_public = stage.kind == Symbol::new(env, "public");
        let (limit, price) = if is_public {
            (stage.per_wallet_limit, stage.price)
        } else {
            let entry = env
                .storage()
                .instance()
                .get::<_, AllowListEntry>(&DataKey::AllowList(stage_id, to.clone()))
                .expect("not on the allowlist for this stage");
            if !entry.allowed {
                panic!("not on the allowlist for this stage");
            }
            (
                entry.custom_limit.unwrap_or(stage.per_wallet_limit),
                entry.custom_price.unwrap_or(stage.price),
            )
        };

        // Per-wallet limit.
        let wallet_minted = if is_public {
            env.storage()
                .instance()
                .get::<_, u32>(&DataKey::PublicStageMint(stage_id, to.clone()))
                .unwrap_or(0)
        } else {
            env.storage()
                .instance()
                .get::<_, AllowListEntry>(&DataKey::AllowList(stage_id, to.clone()))
                .unwrap()
                .minted
        };
        if wallet_minted + quantity > limit {
            panic!("per-wallet mint limit exceeded");
        }

        // Stage supply.
        if stage.max_supply > 0 {
            let stage_minted: u32 = env.storage().instance().get(&DataKey::StageMinted(stage_id)).unwrap_or(0);
            if stage_minted + quantity > stage.max_supply {
                panic!("stage supply exhausted");
            }
        }

        // Collect payment.
        if price > 0 {
            let payment_token: Address = env.storage().instance().get(&DataKey::PaymentToken).unwrap();
            let client = token::Client::new(env, &payment_token);
            let total = price * quantity as i128;
            let payout: Address = env.storage().instance().get(&DataKey::StageOwner(stage_id)).unwrap_or_else(|| {
                env.storage().instance().get(&DataKey::Admin).unwrap()
            });
            client.transfer(&to, &payout, &total);
        }

        // Mint.
        let mut token_ids: Vec<u32> = Vec::new(env);
        let start_edition = env.storage().instance().get::<_, u32>(&DataKey::StageMinted(stage_id)).unwrap_or(0);
        let stage_uri: Bytes = env.storage().instance().get(&DataKey::StageMetadata(stage_id)).unwrap_or_else(|| {
            env.storage().instance().get::<_, TokenMetadata>(&DataKey::Metadata).unwrap().token_uri
        });
        let edition_count = env.storage().instance().get::<_, u32>(&DataKey::StageEditionCount(stage_id)).unwrap_or(1);
        let stage_scope: String = env.storage().instance().get(&DataKey::StageScope(stage_id)).unwrap_or(String::from_str(env, ""));
        for _ in 0..quantity {
            let token_id = env.storage().instance().get::<_, u32>(&DataKey::NextTokenId).unwrap_or(0);
            let edition_index = start_edition + token_ids.len();
            let collection_revealed = env.storage().instance().get::<_, bool>(&DataKey::CollectionRevealed(stage_scope.clone())).unwrap_or(true);
            let edition_uri = if !collection_revealed { stage_uri.clone() } else if edition_count > 1 { append_edition_uri(env, &stage_uri, edition_index % edition_count) } else { stage_uri.clone() };
            env.storage().instance().set(&DataKey::TokenUri(token_id), &edition_uri);
            env.storage().instance().set(&DataKey::TokenScope(token_id), &stage_scope);
            track_collection_token(env, &stage_scope, token_id);
            do_mint(env, &to, token_id);
            env.storage().instance().set(&DataKey::NextTokenId, &(token_id + 1));
            token_ids.push_back(token_id);
        }

        // Record minted counts.
        if is_public {
            let pub_minted = env.storage().instance().get::<_, u32>(&DataKey::PublicStageMint(stage_id, to.clone())).unwrap_or(0);
            env.storage().instance().set(&DataKey::PublicStageMint(stage_id, to.clone()), &(pub_minted + quantity));
        } else {
            let mut entry = env.storage().instance().get::<_, AllowListEntry>(&DataKey::AllowList(stage_id, to.clone())).unwrap();
            entry.minted += quantity;
            env.storage().instance().set(&DataKey::AllowList(stage_id, to.clone()), &entry);
        }
        let stage_minted: u32 = env.storage().instance().get(&DataKey::StageMinted(stage_id)).unwrap_or(0);
        env.storage().instance().set(&DataKey::StageMinted(stage_id), &(stage_minted + quantity));

        // Include the actual amount collected by the contract (after any
        // allowlist price override) so analytics can count primary volume.
        env.events().publish((Symbol::new(env, "stage_mint"), stage_id, to), (start_edition, token_ids.clone(), price * quantity as i128));
        (start_edition, token_ids)
    }

    // ---- SEP-50 transfer / approvals ----
    pub fn transfer(env: &Env, from: Address, to: Address, token_id: u32) {
        from.require_auth();
        let owner = env.storage().instance().get::<_, Address>(&DataKey::TokenOwner(token_id)).unwrap();
        if owner != from {
            panic!("not the owner");
        }
        do_transfer(env, &from, &to, token_id);
    }

    pub fn transfer_from(env: &Env, spender: Address, from: Address, to: Address, token_id: u32) {
        spender.require_auth();
        let owner = env.storage().instance().get::<_, Address>(&DataKey::TokenOwner(token_id)).unwrap();
        if owner != from {
            panic!("address is not the owner");
        }
        if spender != from {
            let allowance: Allowance = env.storage().instance().get(&DataKey::TokenApproved(token_id)).unwrap();
            if allowance.spender != spender {
                panic!("spender not approved");
            }
            if allowance.live_until_ledger < env.ledger().sequence() {
                panic!("allowance expired");
            }
        }
        do_transfer(env, &from, &to, token_id);
    }

    pub fn set_approved(env: &Env, owner: Address, operator: Address, token_id: u32, approved: bool) {
        owner.require_auth();
        let current_owner = env.storage().instance().get::<_, Address>(&DataKey::TokenOwner(token_id)).unwrap();
        if current_owner != owner {
            panic!("not the owner");
        }
        if approved {
            env.storage().instance().set(
                &DataKey::TokenApproved(token_id),
                &Allowance { spender: operator.clone(), live_until_ledger: u32::MAX },
            );
        } else {
            env.storage().instance().remove(&DataKey::TokenApproved(token_id));
        }
        env.events().publish((Symbol::new(env, "approve"), owner, operator, token_id), approved);
    }

    pub fn approve(env: &Env, from: Address, spender: Address, token_id: u32, live_until_ledger: u32) {
        from.require_auth();
        let owner = env.storage().instance().get::<_, Address>(&DataKey::TokenOwner(token_id)).unwrap();
        if owner != from {
            panic!("not the owner");
        }
        env.storage().instance().set(
            &DataKey::TokenApproved(token_id),
            &Allowance { spender: spender.clone(), live_until_ledger },
        );
        env.events().publish((Symbol::new(env, "approve"), from, spender, token_id), live_until_ledger);
    }

    pub fn get_approved(env: &Env, token_id: u32) -> Option<Address> {
        env.storage().instance().get::<_, Allowance>(&DataKey::TokenApproved(token_id)).map(|a| a.spender)
    }

    pub fn nonce(env: &Env, addr: Address) -> u128 {
        env.storage().instance().get(&DataKey::Nonce(addr)).unwrap_or(0)
    }
}

fn do_mint(env: &Env, to: &Address, token_id: u32) {
    if env.storage().instance().has(&DataKey::TokenOwner(token_id)) {
        panic!("token already minted");
    }
    env.storage().instance().set(&DataKey::TokenOwner(token_id), to);
    env.events().publish((Symbol::new(env, "mint"), to), token_id);
}

fn track_collection_token(env: &Env, scope: &String, token_id: u32) {
    let count = env.storage().instance().get::<_, u32>(&DataKey::CollectionTokenCount(scope.clone())).unwrap_or(0);
    env.storage().instance().set(&DataKey::CollectionToken(scope.clone(), count), &token_id);
    env.storage().instance().set(&DataKey::CollectionTokenCount(scope.clone()), &(count + 1));
}

fn do_transfer(env: &Env, from: &Address, to: &Address, token_id: u32) {
    let prev_owner = env.storage().instance().get::<_, Address>(&DataKey::TokenOwner(token_id)).unwrap();
    if &prev_owner != from {
        panic!("not the owner");
    }
    env.storage().instance().set(&DataKey::TokenOwner(token_id), to);
    env.storage().instance().remove(&DataKey::TokenApproved(token_id));
    bump_nonce(env, from);
    bump_nonce(env, to);
    env.events().publish((Symbol::new(env, "transfer"), from.clone(), to.clone()), token_id);
}

fn bump_nonce(env: &Env, addr: &Address) {
    let nonce: u128 = env.storage().instance().get(&DataKey::Nonce(addr.clone())).unwrap_or(0);
    env.storage().instance().set(&DataKey::Nonce(addr.clone()), &(nonce + 1));
}

fn token_uri_for(env: &Env, meta: &TokenMetadata, token_id: u32) -> Bytes {
    // Real URI = <base_uri><token_id>.
    let mut out = meta.token_uri.clone();
    let mut digits = [0u8; 10];
    let mut value = token_id;
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 { break; }
    }
    let suffix = core::str::from_utf8(&digits[start..]).unwrap();
    out.append(&String::from_str(env, suffix).to_bytes());
    out
}

fn append_edition_uri(env: &Env, base: &Bytes, edition: u32) -> Bytes {
    let mut out = base.clone();
    let mut digits = [0u8; 10];
    let mut value = edition;
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 { break; }
    }
    let suffix = core::str::from_utf8(&digits[start..]).unwrap();
    out.append(&String::from_str(env, suffix).to_bytes());
    out.append(&String::from_str(env, ".json").to_bytes());
    out
}

#[cfg(test)]
mod tests;
