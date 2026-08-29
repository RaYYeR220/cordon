//! Diagnostic contracts. Not part of the shipped product.
//!
//! Everything here exists to isolate a fault in the live system, never to run in it. Each module
//! documents what it strips away and why. See [`echo_gate`] for the enforcement-free anonymizer
//! that bisects a paymaster refusal.

pub mod echo_gate;
