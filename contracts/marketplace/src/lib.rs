#![no_std]

use soroban_sdk::{contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, Env};

const OFFER_TTL_SECONDS: u32 = 73 * 60 * 60;
const MAX_OFFER_TTL_SECONDS: u32 = 90 * 24 * 60 * 60;

#[contractclient(name = "NftClient")]
pub trait NftInterface {
    fn transfer(env: Env, from: Address, to: Address, token_id: u32);
    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, token_id: u32);
    fn owner_of(env: Env, token_id: u32) -> Address;
    fn token_scope(env: Env, token_id: u32) -> Option<soroban_sdk::String>;
    fn collection_owner(env: Env, scope: soroban_sdk::String) -> Option<Address>;
    fn token_trait(env: Env, token_id: u32, name: soroban_sdk::String) -> Option<soroban_sdk::String>;
}

#[derive(Clone)]
#[contracttype]
pub struct Listing {
    pub seller: Address,
    pub nft_contract: Address,
    pub token_id: u32,
    pub payment_token: Address,
    pub price: i128,
    pub expires_at: u32,
    pub active: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct Offer {
    pub buyer: Address,
    pub nft_contract: Address,
    pub token_id: u32,
    pub payment_token: Address,
    pub amount: i128,
    pub expires_at: u32,
    pub active: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct CollectionOffer {
    pub buyer: Address,
    pub nft_contract: Address,
    pub scope: soroban_sdk::String,
    pub payment_token: Address,
    pub amount: i128,
    pub expires_at: u32,
    pub active: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct TraitOffer {
    pub buyer: Address,
    pub nft_contract: Address,
    pub scope: soroban_sdk::String,
    pub trait_type: soroban_sdk::String,
    pub trait_value: soroban_sdk::String,
    pub payment_token: Address,
    pub amount: i128,
    pub expires_at: u32,
    pub active: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct Auction {
    pub seller: Address,
    pub nft_contract: Address,
    pub token_id: u32,
    pub payment_token: Address,
    pub reserve_price: i128,
    pub min_increment: i128,
    pub highest_bid: i128,
    pub highest_bidder: Option<Address>,
    pub starts_at: u32,
    pub ends_at: u32,
    pub active: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    FeeRecipient,
    FeeBps,
    RoyaltyRecipient,
    RoyaltyBps,
    NextListing,
    NextOffer,
    NextAuction,
    NextCollectionOffer,
    NextTraitOffer,
    Listing(u32),
    Offer(u32),
    Auction(u32),
    CreatorRoyalty(Address, soroban_sdk::String),
    RoyaltyProvenanceContract(Address),
    LegacyCollectionOwner(Address, soroban_sdk::String),
    LegacyTokenScope(Address, u32),
    LegacyRoyaltyContract(Address),
    LegacyDefaultScope(Address),
    LegacyScopeCount(Address),
    CollectionOffer(u32),
    TraitOffer(u32),
}

#[derive(Clone)]
#[contracttype]
pub struct Royalty {
    pub recipient: Address,
    pub bps: u32,
}

#[contract]
pub struct NftGramMarketplace;

#[contractimpl]
impl NftGramMarketplace {
    pub fn __constructor(env: &Env, admin: Address, fee_recipient: Address, fee_bps: u32) {
        admin.require_auth();
        if fee_bps > 1_000 { panic!("fee cannot exceed 10%"); }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::RoyaltyRecipient, &admin);
        env.storage().instance().set(&DataKey::RoyaltyBps, &0u32);
        env.storage().instance().set(&DataKey::NextListing, &0u32);
        env.storage().instance().set(&DataKey::NextOffer, &0u32);
        env.storage().instance().set(&DataKey::NextAuction, &0u32);
        env.storage().instance().set(&DataKey::NextCollectionOffer, &0u32);
        env.storage().instance().set(&DataKey::NextTraitOffer, &0u32);
    }

    pub fn list(env: &Env, seller: Address, nft_contract: Address, token_id: u32, payment_token: Address, price: i128, expires_at: u32) -> u32 {
        seller.require_auth();
        if price <= 0 { panic!("price must be positive"); }
        if expires_at <= env.ledger().sequence() { panic!("listing must expire in the future"); }
        let nft = NftClient::new(env, &nft_contract);
        if nft.owner_of(&token_id) != seller { panic!("seller does not own NFT"); }
        nft.transfer_from(&seller, &seller, &env.current_contract_address(), &token_id);
        let listing_id: u32 = env.storage().instance().get(&DataKey::NextListing).unwrap_or(0);
        let listing = Listing { seller: seller.clone(), nft_contract: nft_contract.clone(), token_id, payment_token: payment_token.clone(), price, expires_at, active: true };
        env.storage().persistent().set(&DataKey::Listing(listing_id), &listing);
        env.storage().instance().set(&DataKey::NextListing, &(listing_id + 1));
        env.events().publish((symbol_short!("list"),), (listing_id, seller, nft_contract, token_id, payment_token, price, expires_at));
        listing_id
    }

    pub fn cancel_listing(env: &Env, listing_id: u32) {
        let mut listing: Listing = env.storage().persistent().get(&DataKey::Listing(listing_id)).expect("listing not found");
        listing.seller.require_auth();
        if !listing.active { panic!("listing is inactive"); }
        NftClient::new(env, &listing.nft_contract).transfer(&env.current_contract_address(), &listing.seller, &listing.token_id);
        listing.active = false;
        env.storage().persistent().set(&DataKey::Listing(listing_id), &listing);
        env.events().publish((symbol_short!("cancel"),), listing_id);
    }

    /// Seller can change an escrowed listing without canceling and relisting.
    pub fn update_listing(env: &Env, listing_id: u32, payment_token: Address, price: i128, expires_at: u32) {
        let mut listing: Listing = env.storage().persistent().get(&DataKey::Listing(listing_id)).expect("listing not found");
        listing.seller.require_auth();
        if !listing.active { panic!("listing is inactive"); }
        if listing.expires_at <= env.ledger().sequence() { panic!("listing expired"); }
        if price <= 0 { panic!("price must be positive"); }
        if expires_at <= env.ledger().sequence() { panic!("listing must expire in the future"); }
        listing.payment_token = payment_token.clone();
        listing.price = price;
        listing.expires_at = expires_at;
        env.storage().persistent().set(&DataKey::Listing(listing_id), &listing);
        env.events().publish((symbol_short!("list_u"),), (listing_id, listing.seller, listing.nft_contract, listing.token_id, payment_token, price, expires_at));
    }

    /// Permissionless: anyone can close an expired listing and return the NFT
    /// to its seller even if the seller is unresponsive. No-op for active or
    /// already-closed listings (returns without panic).
    pub fn expire_listing(env: &Env, listing_id: u32) {
        let mut listing: Listing = env.storage().persistent().get(&DataKey::Listing(listing_id)).expect("listing not found");
        if !listing.active { return; }
        if listing.expires_at > env.ledger().sequence() { return; }
        NftClient::new(env, &listing.nft_contract).transfer(&env.current_contract_address(), &listing.seller, &listing.token_id);
        listing.active = false;
        env.storage().persistent().set(&DataKey::Listing(listing_id), &listing);
        env.events().publish((symbol_short!("exp_l"),), listing_id);
    }

    pub fn buy(env: &Env, listing_id: u32, buyer: Address) {
        buyer.require_auth();
        let mut listing: Listing = env.storage().persistent().get(&DataKey::Listing(listing_id)).expect("listing not found");
        if !listing.active { panic!("listing is inactive"); }
        if listing.expires_at <= env.ledger().sequence() { panic!("listing expired"); }
        if buyer == listing.seller { panic!("cannot buy own listing"); }
        token::Client::new(env, &listing.payment_token).transfer(&buyer, &env.current_contract_address(), &listing.price);
        Self::payout(env, &listing.payment_token, listing.price, &listing.seller, &listing.nft_contract, listing.token_id);
        NftClient::new(env, &listing.nft_contract).transfer(&env.current_contract_address(), &buyer, &listing.token_id);
        listing.active = false;
        env.storage().persistent().set(&DataKey::Listing(listing_id), &listing);
        env.events().publish((symbol_short!("sale"),), (listing_id, buyer, listing.seller, listing.nft_contract, listing.token_id, listing.price));
    }

    pub fn make_offer(env: &Env, buyer: Address, nft_contract: Address, token_id: u32, payment_token: Address, amount: i128, requested_expiry: u32) -> u32 {
        buyer.require_auth();
        if amount <= 0 { panic!("offer must be positive"); }
        let now = u32::try_from(env.ledger().timestamp()).expect("ledger timestamp overflow");
        let expires_at = if requested_expiry == 0 {
            now.checked_add(OFFER_TTL_SECONDS).expect("offer expiry overflow")
        } else {
            if requested_expiry <= now { panic!("offer expiry must be in the future"); }
            if requested_expiry > now.checked_add(MAX_OFFER_TTL_SECONDS).expect("offer expiry overflow") { panic!("offer expiry exceeds 90 days"); }
            requested_expiry
        };
        token::Client::new(env, &payment_token).transfer(&buyer, &env.current_contract_address(), &amount);
        let offer_id: u32 = env.storage().instance().get(&DataKey::NextOffer).unwrap_or(0);
        let offer = Offer { buyer: buyer.clone(), nft_contract: nft_contract.clone(), token_id, payment_token: payment_token.clone(), amount, expires_at, active: true };
        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.storage().instance().set(&DataKey::NextOffer, &(offer_id + 1));
        env.events().publish((symbol_short!("offer"),), (offer_id, buyer, nft_contract, token_id, payment_token, amount, expires_at));
        offer_id
    }

    /// Atomically replace a buyer's escrowed offer after accepting a counter.
    /// This prevents the original offer being canceled if the replacement fails.
    pub fn replace_offer(env: &Env, offer_id: u32, buyer: Address, amount: i128) -> u32 {
        buyer.require_auth();
        if amount <= 0 { panic!("offer must be positive"); }
        let mut old: Offer = env.storage().persistent().get(&DataKey::Offer(offer_id)).expect("offer not found");
        if !old.active { panic!("offer is inactive"); }
        if old.buyer != buyer { panic!("only offer buyer can replace it"); }
        if old.expires_at <= env.ledger().timestamp() as u32 { panic!("offer expired"); }

        let payment = token::Client::new(env, &old.payment_token);
        payment.transfer(&env.current_contract_address(), &buyer, &old.amount);
        payment.transfer(&buyer, &env.current_contract_address(), &amount);
        old.active = false;
        env.storage().persistent().set(&DataKey::Offer(offer_id), &old);
        env.events().publish((symbol_short!("offer_c"),), offer_id);

        let expires_at = (env.ledger().timestamp() as u32).checked_add(OFFER_TTL_SECONDS).expect("offer expiry overflow");
        let new_id: u32 = env.storage().instance().get(&DataKey::NextOffer).unwrap_or(0);
        let replacement = Offer { buyer: buyer.clone(), nft_contract: old.nft_contract.clone(), token_id: old.token_id, payment_token: old.payment_token.clone(), amount, expires_at, active: true };
        env.storage().persistent().set(&DataKey::Offer(new_id), &replacement);
        env.storage().instance().set(&DataKey::NextOffer, &(new_id + 1));
        env.events().publish((symbol_short!("offer"),), (new_id, buyer, old.nft_contract, old.token_id, old.payment_token, amount, expires_at));
        new_id
    }

    /// Anyone may reclaim escrow after an offer expires; funds go back to its buyer.
    pub fn expire_offer(env: &Env, offer_id: u32) {
        let mut offer: Offer = env.storage().persistent().get(&DataKey::Offer(offer_id)).expect("offer not found");
        if !offer.active { return; }
        if offer.expires_at > env.ledger().timestamp() as u32 { return; }
        token::Client::new(env, &offer.payment_token).transfer(&env.current_contract_address(), &offer.buyer, &offer.amount);
        offer.active = false;
        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.events().publish((symbol_short!("exp_o"),), offer_id);
    }

    /// Escrow a collection-wide offer. A seller must choose a specific token
    /// in that collection when accepting it.
    pub fn make_collection_offer(env: &Env, buyer: Address, nft_contract: Address, scope: soroban_sdk::String, payment_token: Address, amount: i128) -> u32 {
        buyer.require_auth();
        if scope.is_empty() || amount <= 0 { panic!("invalid collection offer"); }
        token::Client::new(env, &payment_token).transfer(&buyer, &env.current_contract_address(), &amount);
        let now = u32::try_from(env.ledger().timestamp()).expect("ledger timestamp overflow");
        let expires_at = now.checked_add(OFFER_TTL_SECONDS).expect("offer expiry overflow");
        let offer_id: u32 = env.storage().instance().get(&DataKey::NextCollectionOffer).unwrap_or(0);
        let offer = CollectionOffer { buyer: buyer.clone(), nft_contract: nft_contract.clone(), scope: scope.clone(), payment_token: payment_token.clone(), amount, expires_at, active: true };
        env.storage().persistent().set(&DataKey::CollectionOffer(offer_id), &offer);
        env.storage().instance().set(&DataKey::NextCollectionOffer, &(offer_id + 1));
        env.events().publish((symbol_short!("c_off"),), (offer_id, buyer, nft_contract, scope, payment_token, amount, expires_at));
        offer_id
    }

    pub fn accept_collection_offer(env: &Env, offer_id: u32, seller: Address, token_id: u32) {
        seller.require_auth();
        let mut offer: CollectionOffer = env.storage().persistent().get(&DataKey::CollectionOffer(offer_id)).expect("offer not found");
        if !offer.active { panic!("offer is inactive"); }
        if offer.expires_at <= env.ledger().timestamp() as u32 { panic!("offer expired"); }
        if seller == offer.buyer { panic!("cannot accept own offer"); }
        let nft = NftClient::new(env, &offer.nft_contract);
        if nft.token_scope(&token_id) != Some(offer.scope.clone()) { panic!("token is not in offered collection"); }
        if nft.owner_of(&token_id) != seller { panic!("seller does not own NFT"); }
        Self::payout(env, &offer.payment_token, offer.amount, &seller, &offer.nft_contract, token_id);
        nft.transfer_from(&seller, &seller, &offer.buyer, &token_id);
        offer.active = false;
        env.storage().persistent().set(&DataKey::CollectionOffer(offer_id), &offer);
        env.events().publish((symbol_short!("c_sale"),), (offer_id, offer.buyer, seller, offer.nft_contract, token_id, offer.amount));
    }

    pub fn cancel_collection_offer(env: &Env, offer_id: u32) {
        let mut offer: CollectionOffer = env.storage().persistent().get(&DataKey::CollectionOffer(offer_id)).expect("offer not found");
        offer.buyer.require_auth();
        if !offer.active { panic!("offer is inactive"); }
        token::Client::new(env, &offer.payment_token).transfer(&env.current_contract_address(), &offer.buyer, &offer.amount);
        offer.active = false;
        env.storage().persistent().set(&DataKey::CollectionOffer(offer_id), &offer);
        env.events().publish((symbol_short!("c_c"),), offer_id);
    }

    pub fn expire_collection_offer(env: &Env, offer_id: u32) {
        let mut offer: CollectionOffer = env.storage().persistent().get(&DataKey::CollectionOffer(offer_id)).expect("offer not found");
        if !offer.active || offer.expires_at > env.ledger().timestamp() as u32 { return; }
        token::Client::new(env, &offer.payment_token).transfer(&env.current_contract_address(), &offer.buyer, &offer.amount);
        offer.active = false;
        env.storage().persistent().set(&DataKey::CollectionOffer(offer_id), &offer);
        env.events().publish((symbol_short!("c_exp"),), offer_id);
    }

    pub fn get_collection_offer(env: &Env, offer_id: u32) -> CollectionOffer {
        env.storage().persistent().get(&DataKey::CollectionOffer(offer_id)).expect("offer not found")
    }

    /// Escrow an offer for any NFT in a collection with a creator-committed trait.
    pub fn make_trait_offer(env: &Env, buyer: Address, nft_contract: Address, scope: soroban_sdk::String, trait_type: soroban_sdk::String, trait_value: soroban_sdk::String, payment_token: Address, amount: i128) -> u32 {
        buyer.require_auth();
        if scope.is_empty() || trait_type.is_empty() || trait_value.is_empty() || amount <= 0 { panic!("invalid trait offer"); }
        token::Client::new(env, &payment_token).transfer(&buyer, &env.current_contract_address(), &amount);
        let now = u32::try_from(env.ledger().timestamp()).expect("ledger timestamp overflow");
        let expires_at = now.checked_add(OFFER_TTL_SECONDS).expect("offer expiry overflow");
        let offer_id = env.storage().instance().get::<_, u32>(&DataKey::NextTraitOffer).unwrap_or(0);
        let offer = TraitOffer { buyer: buyer.clone(), nft_contract: nft_contract.clone(), scope: scope.clone(), trait_type: trait_type.clone(), trait_value: trait_value.clone(), payment_token: payment_token.clone(), amount, expires_at, active: true };
        env.storage().persistent().set(&DataKey::TraitOffer(offer_id), &offer);
        env.storage().instance().set(&DataKey::NextTraitOffer, &(offer_id + 1));
        env.events().publish((symbol_short!("t_off"),), (offer_id, buyer, nft_contract, scope, trait_type, trait_value, payment_token, amount, expires_at));
        offer_id
    }

    pub fn accept_trait_offer(env: &Env, offer_id: u32, seller: Address, token_id: u32) {
        seller.require_auth();
        let mut offer: TraitOffer = env.storage().persistent().get(&DataKey::TraitOffer(offer_id)).expect("offer not found");
        if !offer.active { panic!("offer is inactive"); }
        if offer.expires_at <= env.ledger().timestamp() as u32 { panic!("offer expired"); }
        if seller == offer.buyer { panic!("cannot accept own offer"); }
        let nft = NftClient::new(env, &offer.nft_contract);
        if nft.token_scope(&token_id) != Some(offer.scope.clone()) { panic!("token is not in offered collection"); }
        if nft.token_trait(&token_id, &offer.trait_type) != Some(offer.trait_value.clone()) { panic!("token does not match offered trait"); }
        if nft.owner_of(&token_id) != seller { panic!("seller does not own NFT"); }
        Self::payout(env, &offer.payment_token, offer.amount, &seller, &offer.nft_contract, token_id);
        nft.transfer_from(&seller, &seller, &offer.buyer, &token_id);
        offer.active = false;
        env.storage().persistent().set(&DataKey::TraitOffer(offer_id), &offer);
        env.events().publish((symbol_short!("t_sale"),), (offer_id, offer.buyer, seller, offer.nft_contract, token_id, offer.amount));
    }

    pub fn cancel_trait_offer(env: &Env, offer_id: u32) {
        let mut offer: TraitOffer = env.storage().persistent().get(&DataKey::TraitOffer(offer_id)).expect("offer not found");
        offer.buyer.require_auth();
        if !offer.active { panic!("offer is inactive"); }
        token::Client::new(env, &offer.payment_token).transfer(&env.current_contract_address(), &offer.buyer, &offer.amount);
        offer.active = false;
        env.storage().persistent().set(&DataKey::TraitOffer(offer_id), &offer);
        env.events().publish((symbol_short!("t_c"),), offer_id);
    }

    pub fn expire_trait_offer(env: &Env, offer_id: u32) {
        let mut offer: TraitOffer = env.storage().persistent().get(&DataKey::TraitOffer(offer_id)).expect("offer not found");
        if !offer.active || offer.expires_at > env.ledger().timestamp() as u32 { return; }
        token::Client::new(env, &offer.payment_token).transfer(&env.current_contract_address(), &offer.buyer, &offer.amount);
        offer.active = false;
        env.storage().persistent().set(&DataKey::TraitOffer(offer_id), &offer);
        env.events().publish((symbol_short!("t_exp"),), offer_id);
    }

    pub fn get_trait_offer(env: &Env, offer_id: u32) -> TraitOffer {
        env.storage().persistent().get(&DataKey::TraitOffer(offer_id)).expect("offer not found")
    }

    pub fn cancel_offer(env: &Env, offer_id: u32) {
        let mut offer: Offer = env.storage().persistent().get(&DataKey::Offer(offer_id)).expect("offer not found");
        offer.buyer.require_auth();
        if !offer.active { panic!("offer is inactive"); }
        token::Client::new(env, &offer.payment_token).transfer(&env.current_contract_address(), &offer.buyer, &offer.amount);
        offer.active = false;
        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.events().publish((symbol_short!("offer_c"),), offer_id);
    }

    /// The current owner can cancel a received offer; escrow is returned to its buyer.
    pub fn cancel_offer_by_owner(env: &Env, offer_id: u32, owner: Address) {
        owner.require_auth();
        let mut offer: Offer = env.storage().persistent().get(&DataKey::Offer(offer_id)).expect("offer not found");
        if !offer.active { panic!("offer is inactive"); }
        if owner == offer.buyer { panic!("buyer must use cancel_offer"); }
        if NftClient::new(env, &offer.nft_contract).owner_of(&offer.token_id) != owner { panic!("caller does not own NFT"); }
        token::Client::new(env, &offer.payment_token).transfer(&env.current_contract_address(), &offer.buyer, &offer.amount);
        offer.active = false;
        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.events().publish((symbol_short!("offer_r"),), (offer_id, owner, offer.buyer));
    }

    pub fn accept_offer(env: &Env, offer_id: u32, seller: Address) {
        seller.require_auth();
        let mut offer: Offer = env.storage().persistent().get(&DataKey::Offer(offer_id)).expect("offer not found");
        if !offer.active { panic!("offer is inactive"); }
        if offer.expires_at <= env.ledger().timestamp() as u32 { panic!("offer expired"); }
        if seller == offer.buyer { panic!("cannot accept own offer"); }
        let nft = NftClient::new(env, &offer.nft_contract);
        if nft.owner_of(&offer.token_id) != seller { panic!("seller does not own NFT"); }
        Self::payout(env, &offer.payment_token, offer.amount, &seller, &offer.nft_contract, offer.token_id);
        nft.transfer_from(&seller, &seller, &offer.buyer, &offer.token_id);
        offer.active = false;
        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.events().publish((symbol_short!("offer_s"),), (offer_id, offer.buyer, seller, offer.nft_contract, offer.token_id, offer.amount));
    }

    pub fn create_auction(env: &Env, seller: Address, nft_contract: Address, token_id: u32, payment_token: Address, reserve_price: i128, min_increment: i128, starts_at: u32, ends_at: u32) -> u32 {
        seller.require_auth();
        if reserve_price <= 0 { panic!("reserve price must be positive"); }
        if min_increment < 0 { panic!("increment cannot be negative"); }
        if starts_at < env.ledger().sequence() || ends_at <= starts_at { panic!("invalid auction window"); }
        let nft = NftClient::new(env, &nft_contract);
        if nft.owner_of(&token_id) != seller { panic!("seller does not own NFT"); }
        nft.transfer_from(&seller, &seller, &env.current_contract_address(), &token_id);
        let auction_id: u32 = env.storage().instance().get(&DataKey::NextAuction).unwrap_or(0);
        let auction = Auction { seller: seller.clone(), nft_contract: nft_contract.clone(), token_id, payment_token: payment_token.clone(), reserve_price, min_increment, highest_bid: 0, highest_bidder: None, starts_at, ends_at, active: true };
        env.storage().persistent().set(&DataKey::Auction(auction_id), &auction);
        env.storage().instance().set(&DataKey::NextAuction, &(auction_id + 1));
        env.events().publish((symbol_short!("auction"),), (auction_id, seller, nft_contract, token_id, payment_token, reserve_price, min_increment, starts_at, ends_at));
        auction_id
    }

    pub fn bid(env: &Env, auction_id: u32, bidder: Address, amount: i128) {
        bidder.require_auth();
        let mut auction: Auction = env.storage().persistent().get(&DataKey::Auction(auction_id)).expect("auction not found");
        if !auction.active { panic!("auction is inactive"); }
        if bidder == auction.seller { panic!("cannot bid own auction"); }
        let now = env.ledger().sequence();
        if now < auction.starts_at || now >= auction.ends_at { panic!("auction is not live"); }
        if amount < auction.reserve_price { panic!("bid must meet reserve"); }
        if amount < auction.highest_bid + auction.min_increment { panic!("bid must increase by minimum increment"); }
        if amount <= auction.highest_bid { panic!("bid must exceed current bid"); }
        token::Client::new(env, &auction.payment_token).transfer(&bidder, &env.current_contract_address(), &amount);
        if let Some(previous) = auction.highest_bidder {
            if auction.highest_bid > 0 { token::Client::new(env, &auction.payment_token).transfer(&env.current_contract_address(), &previous, &auction.highest_bid); }
        }
        auction.highest_bid = amount;
        auction.highest_bidder = Some(bidder.clone());
        env.storage().persistent().set(&DataKey::Auction(auction_id), &auction);
        env.events().publish((symbol_short!("bid"),), (auction_id, bidder, amount));
    }

    pub fn cancel_auction(env: &Env, auction_id: u32) {
        let mut auction: Auction = env.storage().persistent().get(&DataKey::Auction(auction_id)).expect("auction not found");
        auction.seller.require_auth();
        if !auction.active { panic!("auction is inactive"); }
        if auction.highest_bidder.is_some() { panic!("auction with bids cannot be cancelled"); }
        NftClient::new(env, &auction.nft_contract).transfer(&env.current_contract_address(), &auction.seller, &auction.token_id);
        auction.active = false;
        env.storage().persistent().set(&DataKey::Auction(auction_id), &auction);
        env.events().publish((symbol_short!("auc_c"),), auction_id);
    }

    pub fn settle_auction(env: &Env, auction_id: u32) {
        let mut auction: Auction = env.storage().persistent().get(&DataKey::Auction(auction_id)).expect("auction not found");
        if !auction.active { panic!("auction is inactive"); }
        if env.ledger().sequence() < auction.ends_at { panic!("auction is still live"); }
        if let Some(winner) = auction.highest_bidder.clone() {
            Self::payout(env, &auction.payment_token, auction.highest_bid, &auction.seller, &auction.nft_contract, auction.token_id);
            NftClient::new(env, &auction.nft_contract).transfer(&env.current_contract_address(), &winner, &auction.token_id);
            env.events().publish((symbol_short!("auc_s"),), (auction_id, winner, auction.seller.clone(), auction.nft_contract.clone(), auction.token_id, auction.highest_bid));
        } else {
            NftClient::new(env, &auction.nft_contract).transfer(&env.current_contract_address(), &auction.seller, &auction.token_id);
            env.events().publish((symbol_short!("auc_e"),), auction_id);
        }
        auction.active = false;
        env.storage().persistent().set(&DataKey::Auction(auction_id), &auction);
    }

    pub fn get_listing(env: &Env, listing_id: u32) -> Listing { env.storage().persistent().get(&DataKey::Listing(listing_id)).expect("listing not found") }
    pub fn get_offer(env: &Env, offer_id: u32) -> Offer { env.storage().persistent().get(&DataKey::Offer(offer_id)).expect("offer not found") }
    pub fn get_auction(env: &Env, auction_id: u32) -> Auction { env.storage().persistent().get(&DataKey::Auction(auction_id)).expect("auction not found") }

    pub fn set_fee(env: &Env, fee_recipient: Address, fee_bps: u32) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("admin missing");
        admin.require_auth();
        if fee_bps > 1_000 { panic!("fee cannot exceed 10%"); }
        env.storage().instance().set(&DataKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
    }

    pub fn set_royalty(env: &Env, royalty_recipient: Address, royalty_bps: u32) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("admin missing");
        admin.require_auth();
        if royalty_bps > 1_000 { panic!("royalty cannot exceed 10%"); }
        env.storage().instance().set(&DataKey::RoyaltyRecipient, &royalty_recipient);
        env.storage().instance().set(&DataKey::RoyaltyBps, &royalty_bps);
    }

    /// The server registers ownership and token scopes for older NFT contracts
    /// that predate the collection provenance getters. Registration is gated by
    /// marketplace admin after it verifies the collection owner in the app DB.
    pub fn register_legacy_collection(env: &Env, nft_contract: Address, scope: soroban_sdk::String, creator: Address, token_ids: soroban_sdk::Vec<u32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("admin missing");
        admin.require_auth();
        if scope.is_empty() { panic!("collection scope is required"); }
        if token_ids.len() > 100 { panic!("register at most 100 token scopes per transaction"); }
        let owner_key = DataKey::LegacyCollectionOwner(nft_contract.clone(), scope.clone());
        let existing: Option<Address> = env.storage().persistent().get(&owner_key);
        if existing.is_some() && existing != Some(creator.clone()) { panic!("legacy collection creator cannot be changed"); }
        if existing.is_none() {
            let count: u32 = env.storage().persistent().get(&DataKey::LegacyScopeCount(nft_contract.clone())).unwrap_or(0);
            env.storage().persistent().set(&DataKey::LegacyScopeCount(nft_contract.clone()), &(count + 1));
            if count == 0 { env.storage().persistent().set(&DataKey::LegacyDefaultScope(nft_contract.clone()), &scope); }
            else { env.storage().persistent().remove(&DataKey::LegacyDefaultScope(nft_contract.clone())); }
        }
        env.storage().persistent().set(&owner_key, &creator);
        for token_id in token_ids.iter() {
            let key = DataKey::LegacyTokenScope(nft_contract.clone(), token_id);
            let current: Option<soroban_sdk::String> = env.storage().persistent().get(&key);
            if current.is_some() && current != Some(scope.clone()) { panic!("legacy token scope cannot be changed"); }
            env.storage().persistent().set(&key, &scope);
        }
        env.storage().persistent().set(&DataKey::LegacyRoyaltyContract(nft_contract), &true);
    }

    /// Creator controls the royalty for their collection. The NFT contract is
    /// the source of truth for creator identity, so marketplace admins cannot
    /// claim or redirect another creator's royalty.
    pub fn set_creator_royalty(env: &Env, nft_contract: Address, scope: soroban_sdk::String, creator: Address, recipient: Address, bps: u32) {
        creator.require_auth();
        if bps > 1_000 { panic!("royalty cannot exceed 10%"); }
        let registered_creator: Option<Address> = env.storage().persistent().get(&DataKey::LegacyCollectionOwner(nft_contract.clone(), scope.clone()));
        if let Some(registered_creator) = registered_creator {
            if registered_creator != creator { panic!("caller is not the collection creator"); }
            env.storage().persistent().set(&DataKey::LegacyRoyaltyContract(nft_contract.clone()), &true);
        } else {
            let nft = NftClient::new(env, &nft_contract);
            if nft.collection_owner(&scope) != Some(creator.clone()) { panic!("caller is not the collection creator"); }
            env.storage().persistent().set(&DataKey::RoyaltyProvenanceContract(nft_contract.clone()), &true);
        }
        env.storage().persistent().set(&DataKey::CreatorRoyalty(nft_contract.clone(), scope), &Royalty { recipient, bps });
    }

    fn payout(env: &Env, payment_token: &Address, amount: i128, seller: &Address, nft_contract: &Address, token_id: u32) {
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let default_royalty_bps: u32 = env.storage().instance().get(&DataKey::RoyaltyBps).unwrap_or(0);
        let fee_recipient: Address = env.storage().instance().get(&DataKey::FeeRecipient).expect("fee recipient missing");
        let default_royalty_recipient: Address = env.storage().instance().get(&DataKey::RoyaltyRecipient).expect("royalty recipient missing");
        // Keep legacy NFT contracts usable: only call the new provenance
        // getters for collections whose creator explicitly enabled royalties.
        let legacy_royalty: bool = env.storage().persistent().get(&DataKey::LegacyRoyaltyContract(nft_contract.clone())).unwrap_or(false);
        let supports_provenance: bool = env.storage().persistent().get(&DataKey::RoyaltyProvenanceContract(nft_contract.clone())).unwrap_or(false);
        let scoped = if legacy_royalty {
            let scope = env.storage().persistent().get::<_, soroban_sdk::String>(&DataKey::LegacyTokenScope(nft_contract.clone(), token_id)).or_else(|| env.storage().persistent().get(&DataKey::LegacyDefaultScope(nft_contract.clone())));
            scope.and_then(|scope| env.storage().persistent().get::<_, Royalty>(&DataKey::CreatorRoyalty(nft_contract.clone(), scope)))
        } else if supports_provenance {
            NftClient::new(env, nft_contract).token_scope(&token_id).and_then(|scope| env.storage().persistent().get::<_, Royalty>(&DataKey::CreatorRoyalty(nft_contract.clone(), scope)))
        } else { None };
        let (royalty_recipient, royalty_bps) = scoped.map(|royalty| (royalty.recipient, royalty.bps)).unwrap_or((default_royalty_recipient, default_royalty_bps));
        let fee = amount * fee_bps as i128 / 10_000;
        let royalty = amount * royalty_bps as i128 / 10_000;
        if fee + royalty >= amount { panic!("fees exceed sale amount"); }
        let payment = token::Client::new(env, payment_token);
        payment.transfer(&env.current_contract_address(), seller, &(amount - fee - royalty));
        if fee > 0 { payment.transfer(&env.current_contract_address(), &fee_recipient, &fee); }
        if royalty > 0 { payment.transfer(&env.current_contract_address(), &royalty_recipient, &royalty); }
    }
}

#[cfg(test)]
mod tests;
