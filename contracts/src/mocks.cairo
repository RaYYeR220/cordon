//! Test doubles.
//!
//! These contracts exist only for the snforge suite and are compiled out of every other target.
//! They are deliberately minimal: just enough of an ERC20 and just enough of the privacy pool's
//! calling convention to exercise the gate the way mainnet will.

pub mod mock_erc20;
pub mod mock_pool;
