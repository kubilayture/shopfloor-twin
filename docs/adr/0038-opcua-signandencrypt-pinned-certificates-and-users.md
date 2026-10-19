# ADR-0038: OPC UA SignAndEncrypt with a pki step, pinned leaf certificates and two users

- Status: accepted (#239, P9-12: OPC UA address space 1.3)
- Date: 2026-10-19
- Deciders: Claude (#239), within the Phase 9 plan ("OPC UA security", review decisions round 1 finding 9, round 2 finding 2, round 3 findings 6 and 7, and the final check); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Until Phase 9 every machine server offered security mode None to anonymous clients, any client could call `LoadOrder` and `LoadProgram`, and both sides accepted any certificate (`automaticallyAcceptUnknownCertificate: true` in `machine-server.ts` and in the gateway's `main.ts`). node-opcua made each server's and the gateway's certificate on first start, in the simulator's and the gateway's volumes. The master plan's security row (section 9) and the Phase 9 plan ask for SignAndEncrypt with pinned certificates and named users. The questions:

- What does SignAndEncrypt cost at 60×, and does ADR-0009's lossless delivery hold under it (probe Q1)?
- Whom does a server trust, and whom does the gateway trust: a CA, or each other's certificates?
- Who makes the keys and certificates, when, and where do they live, given that a component which makes its own on first start does so too late for anything to pin it beforehand?
- Who may connect, and who may call the two command methods?
- How do tests outside Compose get the same setup, and what happens at expiry?

## Probe Q1 (#239, first commit)

`apps/simulator/spikes/opcua-security.ts`: the five servers, two clients each (the gateway's certificate as `opcua-gateway` and the tools certificate as `opcua-reader`), seed 20261012, `Basic256Sha256`, one mode per process. Results in `docs/phases/phase-09-log.md` (#239):

- **Lossless:** the rest of Monday's shift A on a manual clock (far faster than a real 60×) delivered all 1,546 events to each of the ten clients, gap-free and in order, in both modes; 120 simulated minutes paced at 60× likewise (798 notifications).
- **Cost** in a container capped at 1.0 CPU on the Colima VM (4 CPU, 4 GiB): 205 µs of process CPU per delivered notification under None, 313 µs under SignAndEncrypt (servers and clients together); paced at 60×, 0.8 % against 2.1 % of one core; delivery latency p50 / p95 / max 51.0 / 96.1 / 99.2 ms against 54.8 / 97.4 / 114.8 ms (the 100 ms publishing interval dominates). No threat to the Phase 9 performance targets.
- **Refusals:** a client certificate the server doesn't pin: `BadSecurityChecksFailed`.
- **A CA-issued certificate:** with the CA trusted and no CRL, node-opcua refuses the client with `BadCertificateRevocationUnknown`; with an (empty) CRL for that CA it accepts it, and would accept any other certificate the CA signs.

## Considered options

1. **Trust:** (a) a shared dev CA (also the HTTPS and MQTT CA of P9-14); (b) a separate OPC UA CA with extended-key-usage and `applicationUri` checks; (c) pinned leaf certificates.
2. **Who makes the material:** (a) each component on first start, as before, with a later exchange; (b) a one-shot step before the components start, writing into each component's own volume.
3. **Users:** (a) anonymous over SignAndEncrypt; (b) user names and passwords; (c) X.509 user tokens.
4. **Method access:** (a) a check in each method's handler; (b) OPC UA `RolePermissions` on the method nodes.
5. **Tests outside Compose:** (a) always None; (b) the same exchange code as the step, or `OPCUA_SECURITY=none` where a test doesn't test security.

## Decision outcome

Chosen: 1c, 2b, 3b, 4b and 5b.

- **Endpoints:** SignAndEncrypt only, `Basic256Sha256` and `Aes128_Sha256_RsaOaep`; no None endpoint; user-name tokens only (node-opcua offers X.509 user tokens too and its `userTokenTypes` option isn't passed on in 2.187, so the policies are taken off the endpoint descriptions after `initialize()`; the server then has no policy for such a token). `automaticallyAcceptUnknownCertificate: false` on all five servers and in the gateway, so a certificate is trusted only when it is in the receiver's `trusted/certs`. node-opcua's `applicationUri` check stays on (a pinned certificate presented under another application's URI: `BadCertificateUriInvalid`).
- **The `pki` step** (`@shopfloor/pki`, `ensureOpcuaPki`; Compose's one-shot service `pki`, the simulator image running `packages/pki/src/cli.ts`): for each of the five machine servers, the gateway and the tools client it makes an RSA 2048 key and a self-signed certificate, valid 365 days:
  - SAN: the component's `applicationUri` as the first URI (`urn:orbis-components:shopfloor-twin:<machineId>`, `…:edge-gateway`, `…:tools`), and DNS `simulator` and `localhost` for the servers (the gateway reaches them as `simulator`, host tools as `localhost`), `gateway` for the gateway and `localhost` for the tools client;
  - key usage `digitalSignature`, `nonRepudiation`, `keyEncipherment`, `dataEncipherment` and `keyCertSign` (critical), basic constraints CA:false, extended key usage `serverAuth` for a server and `clientAuth` for a client (OPC UA Part 6, 6.2.2);
  - files at node-opcua's default paths, `own/certs/certificate.pem` and `own/private/private_key.pem` (mode 600), passed explicitly as `certificateFile` and `privateKeyFile` by the servers and the gateway (node-opcua's client default would be `client_certificate.pem`; explicit paths make that irrelevant); a server's folder is `<simulator pki>/<machineId>`;
  - pins: each server's `trusted/certs` holds the gateway's and the tools certificates; the gateway's and the tools client's hold the five servers'; written as `<peer>.pem`.
  - It keeps existing material that is valid for more than 30 days and still says what the step would write (URI, DNS names, exactly the one extended key usage, a matching key); anything else is replaced, so certificates node-opcua made before #239 (both usages) are replaced on the first run. **On renewal** it first removes from every `trusted/certs` a certificate of one of its identities that isn't that identity's current one (whatever its file name), then writes the current pins: a renewed certificate's predecessor is trusted nowhere. Files of other origin in `trusted/certs` are left alone. `PKI_RENEW` names identities to renew at once.
  - **Volumes:** `simulator-pki`, `gateway-pki` and `opcua-tools-pki`; the step is the only service that mounts all three, and only while it runs; the simulator mounts its own, the gateway its own (beside its buffer volume), and `opcua-tools` its own; no long-running service mounts the tools volume. The dev CA's key (P9-14) will live only in a `pki-ca` volume of the same step.
  - **Order:** the simulator and the gateway `depends_on` the step with `condition: service_completed_successfully`, and refuse to start without their certificate (`requireOwnMaterial`: missing, another URI, a key that doesn't match, expired), instead of making one.
  - **Cost per gate project** (every gate project starts from empty volumes): 7 keys and certificates in about 0.3 s in a 1-CPU container (probe Q1: 236–338 ms); the smoke prints the step's own figure.
- **Users:** `opcua-gateway` (`OPCUA_GATEWAY_PASSWORD`, role Operator) and `opcua-reader` (`OPCUA_READER_PASSWORD`, role Observer: browse, read and subscribe). Both random per stack, required (Compose `:?`, the simulator's environment check), in `.env.example` without a value and in the smoke's required-secret check. Passwords are compared as SHA-256 digests with `timingSafeEqual`, an unknown user too. Anonymous sessions are refused: no anonymous token is offered, and one sent anyway is refused by the server (`BadIdentityTokenInvalid`).
- **Methods (address space 1.3):** `LoadOrder` and `LoadProgram` carry `RolePermissions` that grant `Call` to the Operator role only; every role may browse and read them. node-opcua answers anyone else `BadUserAccessDenied` before the handler runs and reports `UserExecutable` false.
- **The tools client:** a third client certificate, pinned on every server like the gateway's, in `opcua-tools-pki`; Compose's `opcua-tools` service (profile `tools`) runs checklist S1 as `opcua-reader` with it (`apps/simulator/src/opcua/security-check.ts`), so S1's permission refusal is tested on a certificate the server trusts.
- **Tests outside Compose:** the exchange step is `ensureOpcuaPki` itself: the simulator's tests (`securePki`) and the test-kit (`testOpcuaPki`, once per test process; each spawned simulator and gateway gets a copy of its own folder) run it before the servers and clients start; the gateway's, the MES's and the simulator's integration and end-to-end tests run SignAndEncrypt that way. `OPCUA_SECURITY=none` (an anonymous None endpoint, methods unrestricted) is kept for the simulator's unit tests that don't test security; Compose has no way to set it. Headless runs and the goldens don't use OPC UA.

### Why pinning (1c)

- No CA can sign its way in: with a CA, every certificate it ever issues opens a session, nginx's included once P9-14's dev CA exists, unless a second, OPC-UA-only CA with EKU and URI checks is run beside it (1b).
- No CRL to keep: probe Q1 shows node-opcua refuses a CA-issued certificate with `BadCertificateRevocationUnknown` until a CRL for the CA is present, and then accepts what the CA signed; pinned self-signed leaves need no revocation list (removing the pin is the revocation).
- The cost is an exchange step, which a one-shot service gives for free, and a renewal that must replace pins, which the step does.

### Consequences

- Good: only the two clients the step pinned can open a session, only with a password, and only the gateway can command a CNC; the channel is encrypted; the evidence is in tests (`apps/simulator/src/opcua/security.test.ts`, the step's `packages/pki/src/pki.test.ts`) and in the smoke (the step exited 0, each volume mounted by its own component, the `opcua-tools` check).
- Good: ADR-0009's lossless delivery and the device sequence hold under SignAndEncrypt: the simulator's integration test of a scripted shift runs secure, with the gateway's and the tools client's certificates, and the reconciliation and end-to-end runs go through the secure gateway.
- Bad: a renewed certificate is picked up at the next start of the component that pins it (node-opcua reads `trusted/certs` when it starts); the runbook says to rerun the step and restart the simulator and the gateway.
- Bad: UaExpert or another generic client needs a certificate pinned on the servers: the tools certificate (copied out of `opcua-tools-pki`) and `opcua-reader`, or its own certificate added to each server's `trusted/certs` by hand (left alone by the step).
- Bad: `onlyUserNameTokens` edits node-opcua's endpoint descriptions after `initialize()`; a node-opcua upgrade that passes `userTokenTypes` on should replace it (the security test fails if a certificate token reappears).
- Known limit (accepted, ADR-0009): events raised while a session is down are still detected, not replayed.
