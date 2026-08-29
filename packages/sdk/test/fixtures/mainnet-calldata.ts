/**
 * Ground truth: the calldata of a real, successful mainnet transaction.
 *
 * Fetched from Starknet mainnet, transaction
 * `0x1c62fa6430e022ef6465efc7af2d501cd619a5f9b60d9cb46ebd38c96f902db`. It is a payment through
 * the privacy pool that reached a diagnostic gate (`EchoGate`, which skips the note-binding
 * check) and succeeded, so this is exactly the shape a working `privacy_invoke` arrives in.
 *
 * The point of keeping it here is what it is *not*: it is not the gate invoke on its own. It is
 * the pool's own transaction, with our invoke nested inside it among the withdraw and transfer
 * actions. The note id sits at index 104 of 111, and the array ends with an unrelated `0x1` —
 * which is precisely what an earlier version of `readResolvedNoteId` read by taking the last
 * felt, producing a binding of `0x1` that made the gate refuse every payment with
 * `CORDON_NOTE_MISMATCH`.
 */

/** The 111 felts of the real transaction, verbatim. */
export const MAINNET_APPLY_ACTIONS_CALLDATA: readonly string[] = [
  "0x2",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e",
  "0x3",
  "0x127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f",
  "0x53444835ec580000",
  "0x0",
  "0x127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f",
  "0x3bd4b5033e788e9cc450fefa99ea20e3bed0fa358c8b280c0488f0c4647472e",
  "0x65",
  "0x1",
  "0x40337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
  "0x246333a752c1ac637ff1591c5c885e27d56060d241a29aad8475072da0777db",
  "0x5c",
  "0x10",
  "0x1",
  "0x31925a2cb59c0f6156cdff7a449c6fe085000b02da1d388da41de678e3b86de",
  "0x16f2d30e8f3f4802dd87043d381ca6c4896f5a02ab2890bc9da79bdeed64a0",
  "0x9d76cea62dd7f2d0bb5df7867ff297316d68b6a353fe99c1d683dde04ade35",
  "0x29da6dc526b5af16a372f651ed2b81b7ffae17bd4d3711518695310a09664ac",
  "0x0",
  "0x406d3a004f218a80a0f9473ae69da22623d6057602e81a2ada0d2e5eb580701",
  "0x1",
  "0x1",
  "0x0",
  "0x3f89a82ff1e06623f09de4c29bf7ad3966f2b7870ede430ac48fd24ed428af1",
  "0x2",
  "0x7faf37fe4b2a8d208650937f934c4cf456c87c8cbb5bdc707dc9b460dcf36a6",
  "0x40ef630ac6f28485fc410416a8f83f97b1b57b62f22f072d009dde79f90418",
  "0x0",
  "0x57ef7206fdd20751c9fdc5c49e348b046773887a562818a6e692c7ecd952fb4",
  "0x2",
  "0x594f0d006ece141c3868d1c21b3091e5ca4d71202730257c47ee1ecdab53a3e",
  "0x7e4f73618d81ac4621cc05778a4af43614c3b3a6c985b20170dbc1497a69de4",
  "0x0",
  "0x12b016e8f35cf9cb63cde08dea555e9fd18ba5e75ccc28bd4662d29a433d53e",
  "0x1",
  "0x1",
  "0x0",
  "0x2928e35632c87a37ed7029ef2e55739f01109edee546da04aeef0b1ee5a73d2",
  "0x1",
  "0x1",
  "0x9",
  "0x7d738f662f6ff852ef446ab0487f8da84198827ac1ca3f77f17bde33bac68d4",
  "0x0",
  "0x3ee526cfe2d4f6122be9c530caddaaafcd2212a26b77f08ffe9bc2b728f3ddd",
  "0x2",
  "0x100000000000000000000000000000000",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x7",
  "0x1eed60b8d483b3bede62d1cc0f32874aea30747e6943437c858359b41801bf7",
  "0xc3c50fbed3305da52930e3272561df22567dcc2999fbc3654d289879559bcf",
  "0x7ad123826634c16f75a92313b4c43b685916d4183a8abbe04606de2836d8cdf",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x93ecdf6405a084c689d141d4dc79ec852528376b5840be266f8d4302585366",
  "0x0",
  "0x15aa3072dcad89aaec2c09974ff675b1166b16336913ff3b3b44b90b4012144",
  "0x1",
  "0xdc23881ec44b7f66f2f103b174363509433021d9bbfff0fb1831659ad5fc08",
  "0x8",
  "0x38e33baaefe2f3eeac1d96620050a8b3ae0370cea21e1f0a796d89da7844b83",
  "0xdc23881ec44b7f66f2f103b174363509433021d9bbfff0fb1831659ad5fc08",
  "0x3",
  "0x22bead6e687f1991bcfac3c4e4408847be7104c900e2afc2fdf02ae2b7c7968",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x1bc16d674ec80000",
  "0x5",
  "0x1eed60b8d483b3bede62d1cc0f32874aea30747e6943437c858359b41801bf7",
  "0x1a1140aae9f208646087ad1533f662f2495c2f31bf69a0c5398faafc0dfd505",
  "0x74cac5de28e5302ab7264719c120102d80e2e6db345c6712f48b3925815a994",
  "0x22bead6e687f1991bcfac3c4e4408847be7104c900e2afc2fdf02ae2b7c7968",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x1bc16d674ec80000",
  "0x3",
  "0x127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x53444835ec580000",
  "0x5",
  "0x1eed60b8d483b3bede62d1cc0f32874aea30747e6943437c858359b41801bf7",
  "0x45d4327adbff8e880786ac0456076d0606b23ecbe7b537c4a3ae57c1af56a89",
  "0x71eff7fd0ee8e00dc2becce1006d18cb455a2a46cdd5a83de99e8507d1af4ea",
  "0x127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x53444835ec580000",
  "0xa",
  "0x22bead6e687f1991bcfac3c4e4408847be7104c900e2afc2fdf02ae2b7c7968", // the gate being invoked
  "0x12", // 0x12 = 18, the length of the invoke calldata
  "0x0", // GateOperation::Direct
  "0x5041595f414343524544495445445f5631",
  "0x434f52444f4e5f4b5943",
  "0x50415945525f4143435245445f31",
  "0x4b025c3478aa86c8cd884780784a261aee4caf4a0520e533eea1095da3bbe29",
  "0x41434352454449544544",
  "0x6aba6d78",
  "0x70ee6745d67c7fc75a6e013188b481e27bbc50907fb49830d4d760fdb906f3e",
  "0x33f893eabbe8360767fc4cfa82efa37f7d6262f1633df1451305e2f42e95956",
  "0x1", // note_binding as it was signed - the bug
  "0x0", // valid_until
  "0x1bc16d674ec80000",
  "0x1ada0a7c69b0f2f085124c60fd9df5d4ab015be876ff5a431b522444679e433",
  "0x3398b4682267ae409ad8dbade4d9b5c05710a436889365cc5acc13046df5c97",
  "0xe82eb14088dd56a5525ce9ee6a495cbf",
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", // token
  "0x40337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a", // pool_address, correctly substituted
  "0x93ecdf6405a084c689d141d4dc79ec852528376b5840be266f8d4302585366", // <- the resolved note id
  "0x1", // a trailing felt, unrelated to the invoke
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "0x53444835ec580000",
  "0x0",
  "0x1",
  "0x3b3986cb9722cdedd9126319e77394ef5f6a09d29952176c24160e8dfcb3ec7",
];

/** The gate the transaction invoked. It also appears twice as a withdraw recipient. */
export const MAINNET_GATE = "0x22bead6e687f1991bcfac3c4e4408847be7104c900e2afc2fdf02ae2b7c7968";

/** The privacy pool. */
export const MAINNET_POOL = "0x40337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

/** The token settled. */
export const MAINNET_TOKEN = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** The note id the transaction actually filled. This is what the reader has to return. */
export const MAINNET_NOTE_ID = "0x93ecdf6405a084c689d141d4dc79ec852528376b5840be266f8d4302585366";

/** Where the invoke calldata starts, and how long it is. */
export const MAINNET_GATE_INDEX = 85;
export const MAINNET_INVOKE_LENGTH = 18;
