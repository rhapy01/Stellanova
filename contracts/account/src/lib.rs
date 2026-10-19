#![no_std]

//! NftGramAccount — SEP-0088 account abstraction for NFTGram.
//!
//! This contract turns a user into an on-chain *contract account* (an
//! `Address`) that authorizes Soroban calls with `require_auth()`, exactly like
//! the marketplace and NFT contracts expect. It is controlled by a stored
//! ed25519 signer key (the credential bound to the user's email).
//!
//! Product fit: a user signs up with an email and gets this account, so their
//! "wallet" is a real Stellar/Soroban account — not a raw keypair. In
//! production the ed25519 signer key is replaced by a passkey/WebAuthn-backed
//! public key (same ED25519 primitive the host crypto verifies), and the
//! account shape stays identical for the marketplace.

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype, crypto::Hash, BytesN, Env, Vec,
};

/// Error type for the account. Explicit integer discriminants make the
/// `#[contracterror]` macro generate the `From<AccountError> for soroban_sdk::Error`
/// conversion required by the `CustomAccountInterface` trait.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccountError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    UnsupportedContext = 3,
}

#[contracttype]
pub enum DataKey {
    PublicKey, // BytesN<32> signer public key
}

#[contract]
pub struct NftGramAccount;

#[contractimpl]
impl NftGramAccount {
    /// One-time registration with the controlling signer public key.
    pub fn __constructor(env: Env, public_key: BytesN<32>) {
        if env.storage().instance().has(&DataKey::PublicKey) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::PublicKey, &public_key);
    }

    pub fn has_owner(env: Env) -> bool {
        env.storage().instance().has(&DataKey::PublicKey)
    }

    pub fn owner(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::PublicKey)
            .expect("account not registered")
    }
}

#[contractimpl]
impl CustomAccountInterface for NftGramAccount {
    type Signature = BytesN<64>;
    type Error = AccountError;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let public_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PublicKey)
            .ok_or(AccountError::NotInitialized)?;

        // The host panics if the signature does not verify against this key.
        env.crypto()
            .ed25519_verify(&public_key, &signature_payload.into(), &signatures);

        // Optionally reject operational contexts the account should not authorize.
        for context in auth_contexts.iter() {
            match context {
                Context::Contract(_) => (),
                Context::CreateContractHostFn(_)
                | Context::CreateContractWithCtorHostFn(_) => {
                    return Err(AccountError::UnsupportedContext);
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod test;
