#![no_std]

use soroban_sdk::{contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, BytesN, ContractExecutable, Env};

const OFFER_TTL_SECONDS: u32 = 73 * 60 * 60;

#[contractclient(name = "NftClient")]
pub trait NftInterface {
    fn transfer(env: Env, from: Address, to: Address, token_id: u32);
    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, token_id: u32);
    fn owner_of(env: Env, token_id: u32) -> Address;
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
    Listing(u32),
    Offer(u32),
    Auction(u32),
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
        Self::payout(env, &listing.payment_token, listing.price, &listing.seller);
        NftClient::new(env, &listing.nft_contract).transfer(&env.current_contract_address(), &buyer, &listing.token_id);
        listing.active = false;
        env.storage().persistent().set(&DataKey::Listing(listing_id), &listing);
        env.events().publish((symbol_short!("sale"),), (listing_id, buyer, listing.seller, listing.nft_contract, listing.token_id, listing.price));
    }

    pub fn make_offer(env: &Env, buyer: Address, nft_contract: Address, token_id: u32, payment_token: Address, amount: i128, _requested_expiry: u32) -> u32 {
        buyer.require_auth();
        if amount <= 0 { panic!("offer must be positive"); }
        // Expiry is always 73 hours from ledger time, never client supplied.
        let expires_at = (env.ledger().timestamp() as u32).checked_add(OFFER_TTL_SECONDS).expect("offer expiry overflow");
        token::Client::new(env, &payment_token).transfer(&buyer, &env.current_contract_address(), &amount);
        let offer_id: u32 = env.storage().instance().get(&DataKey::NextOffer).unwrap_or(0);
        let offer = Offer { buyer: buyer.clone(), nft_contract: nft_contract.clone(), token_id, payment_token: payment_token.clone(), amount, expires_at, active: true };
        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.storage().instance().set(&DataKey::NextOffer, &(offer_id + 1));
        env.events().publish((symbol_short!("offer"),), (offer_id, buyer, nft_contract, token_id, payment_token, amount, expires_at));
        offer_id
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
        Self::payout(env, &offer.payment_token, offer.amount, &seller);
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
            Self::payout(env, &auction.payment_token, auction.highest_bid, &auction.seller);
            NftClient::new(env, &auction.nft_contract).transfer(&env.current_contract_address(), &winner, &auction.token_id);
            env.events().publish((symbol_short!("auc_s"),), (auction_id, winner, auction.seller.clone(), auction.nft_contract.clone(), auction.token_id, auction.highest_bid));
        } else {
            NftClient::new(env, &auction.nft_contract).transfer(&env.current_contract_address(), &auction.seller, &auction.token_id);
        }
        auction.active = false;
        env.storage().persistent().set(&DataKey::Auction(auction_id), &auction);
    }

    pub fn get_listing(env: &Env, listing_id: u32) -> Listing { env.storage().persistent().get(&DataKey::Listing(listing_id)).expect("listing not found") }
    pub fn get_offer(env: &Env, offer_id: u32) -> Offer { env.storage().persistent().get(&DataKey::Offer(offer_id)).expect("offer not found") }
    pub fn get_auction(env: &Env, auction_id: u32) -> Auction { env.storage().persistent().get(&DataKey::Auction(auction_id)).expect("auction not found") }

    pub fn upgrade(env: &Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("admin missing");
        admin.require_auth();
        env.deployer().update_current_contract(ContractExecutable::Wasm(new_wasm_hash));
    }

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

    fn payout(env: &Env, payment_token: &Address, amount: i128, seller: &Address) {
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let royalty_bps: u32 = env.storage().instance().get(&DataKey::RoyaltyBps).unwrap_or(0);
        let fee_recipient: Address = env.storage().instance().get(&DataKey::FeeRecipient).expect("fee recipient missing");
        let royalty_recipient: Address = env.storage().instance().get(&DataKey::RoyaltyRecipient).expect("royalty recipient missing");
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
