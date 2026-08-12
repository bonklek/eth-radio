/**
 * Enforce the one permitted ordering for new signer authority: make the exact
 * reservation durable, expose the post-reservation fault boundary, ask the
 * signer, verify its output, then durably commit the signed attempt.
 */
export async function durableReserveThenSign({
  reservation,
  durableReserve,
  afterDurableReserve = null,
  sign,
  verify,
  durableCommit,
}) {
  await durableReserve(reservation)
  if (afterDurableReserve) await afterDurableReserve(reservation)
  const signed = await sign(reservation)
  await verify(signed, reservation)
  await durableCommit(signed, reservation)
  return signed
}
