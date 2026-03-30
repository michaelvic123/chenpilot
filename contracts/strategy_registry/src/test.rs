#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::{Address as _}, Address, Env, BytesN};

#[test]
fn test_init_and_verified_pools() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, StrategyRegistryContract);
    let client = StrategyRegistryContractClient::new(&env, &contract_id);

    client.init(&admin);

    let pool_id = BytesN::from_array(&env, &[1; 32]);
    client.add_verified_pool(&pool_id);
    assert!(client.is_pool_verified(&pool_id));

    client.remove_verified_pool(&pool_id);
    assert!(!client.is_pool_verified(&pool_id));
}

#[test]
fn test_ai_voting_and_strategy() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let ai_agent = Address::generate(&env);
    let contract_id = env.register_contract(None, StrategyRegistryContract);
    let client = StrategyRegistryContractClient::new(&env, &contract_id);

    client.init(&admin);
    client.set_ai_agent(&ai_agent, &true);

    let pool_1 = BytesN::from_array(&env, &[1; 32]);
    let pool_2 = BytesN::from_array(&env, &[2; 32]);

    client.add_verified_pool(&pool_1);
    client.add_verified_pool(&pool_2);

    // AI votes for pool 1
    client.vote_strategy(&ai_agent, &pool_1);
    assert_eq!(client.get_current_strategy().unwrap(), pool_1);

    // AI votes for pool 2 twice
    let ai_agent_2 = Address::generate(&env);
    client.set_ai_agent(&ai_agent_2, &true);
    client.vote_strategy(&ai_agent_2, &pool_2);
    
    let ai_agent_3 = Address::generate(&env);
    client.set_ai_agent(&ai_agent_3, &true);
    client.vote_strategy(&ai_agent_3, &pool_2);

    assert_eq!(client.get_current_strategy().unwrap(), pool_2);
}

#[test]
#[should_panic(expected = "Pool is not verified")]
fn test_vote_unverified_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let ai_agent = Address::generate(&env);
    let contract_id = env.register_contract(None, StrategyRegistryContract);
    let client = StrategyRegistryContractClient::new(&env, &contract_id);

    client.init(&admin);
    client.set_ai_agent(&ai_agent, &true);

    let pool_id = BytesN::from_array(&env, &[1; 32]);
    // No add_verified_pool here
    client.vote_strategy(&ai_agent, &pool_id);
}

#[test]
#[should_panic(expected = "AI agent not authorized")]
fn test_unauthorized_ai_agent() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let ai_agent = Address::generate(&env);
    let contract_id = env.register_contract(None, StrategyRegistryContract);
    let client = StrategyRegistryContractClient::new(&env, &contract_id);

    client.init(&admin);
    // ai_agent not authorized here

    let pool_id = BytesN::from_array(&env, &[1; 32]);
    client.add_verified_pool(&pool_id);
    client.vote_strategy(&ai_agent, &pool_id);
}
