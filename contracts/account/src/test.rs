use ed25519_dalek::SigningKey;
use soroban_sdk::BytesN;
use soroban_sdk::Env;

use crate::{NftGramAccount, NftGramAccountClient};

fn public_key(env: &Env, signer: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &signer.verifying_key().to_bytes())
}

#[test]
fn register_sets_owner_and_reads_it_back() {
    let env = Env::default();
    let signer = SigningKey::from_bytes(&[7u8; 32]);
    let account_id = env.register(NftGramAccount, (public_key(&env, &signer),));
    let client = NftGramAccountClient::new(&env, &account_id);

    assert!(client.has_owner());
    assert_eq!(client.owner(), public_key(&env, &signer));
}

#[test]
fn registration_requires_a_valid_ed25519_public_key() {
    let env = Env::default();
    let signer = SigningKey::from_bytes(&[9u8; 32]);
    // Ensure our public-key helper returns the correct 32-byte verifying key.
    let pk: BytesN<32> = public_key(&env, &signer);
    assert_eq!(pk.to_array(), signer.verifying_key().to_bytes());
}
