# Renewable device authorization

The client supports a stable, device-scoped refresh credential alongside a short-lived access credential. Neither application shutdown nor inactivity expires the logical binding. This is not an offline article or audio library.

- `POST /v1/zhiyue/device/upgrade` uses the valid legacy access bearer and an empty JSON body. It must return an idempotent renewable binding without changing the logical account or device identity.
- `POST /v1/zhiyue/device/refresh` receives `{ "refresh_token": "..." }` without browser cookies or an access bearer. Successful responses contain `access_token`, `expires_in`, `refresh_token`, `account`, and `binding_id`.
- Renewal is single-flight in each client instance. Replacement credentials are persisted and read back before use. A stable refresh credential allows retry after a lost response or failed persistence without an additional pairing ceremony.
- Startup and reads renew expired access credentials; HTTP 401 triggers one renewal and one retry. A second unauthorized response stops the operation. A temporary network/server error retains the binding. Permanent `invalid_grant` or `invalid_token` clears it.
- Legacy bindings attempt upgrade while still valid. A 404 from an older backend permits continued use of the unexpired legacy binding. Never-upgraded expired legacy bindings require pairing once; a previously successful upgrade with a lost response uses the recovery path below.
- The visible reader/library revalidates at access expiry; transient failures retry while visible. Background execution is not required. Page hiding cancels the page retry timer and clears visible private content.
- Existing HTTPS, account/device isolation, read-only scope, revocation and memory-only content/audio caching remain. The application storage contains device credentials, not the account password or an administrator credential. Hardware-backed storage is not claimed.

## Verification

`node --experimental-vm-modules --test tests/aiui-client.test.mjs` covers existing simulated flows and renewable authorization, multi-round renewal after extended idle time, single-flight concurrency, legacy upgrade, identity validation, temporary failure, revocation and bounded 401 recovery.

These are local Node VM tests, not a deployed backend or Rokid acceptance result. Real hardware testing across restart, phone lock and connectivity loss, plus coordinated backend deployment, remains required. Backend password changes must revoke the device binding; ordinary web logout must not.

## Credential tradeoffs

The refresh credential is stable until revocation, not rotated on each refresh. This deliberately permits recovery after a lost response, but does not provide refresh-token reuse detection. Anyone who extracts that credential can continue read-only access until the account/device authorization is revoked; short access-token lifetime alone does not contain that compromise. Application storage is not claimed to be encrypted or hardware-backed. Protect the device and revoke lost-device bindings from the CMS. No credential is logged or placed in a URL. Device requests reject redirects and omit browser credentials so a redirected POST cannot forward its refresh body to another origin.

## Initial grant confirmation

New claims can return `confirmation_required: true`. The client saves the complete grant with `pendingConfirmation: true` and verifies persistence before sending `POST /v1/zhiyue/device/confirm` with the refresh credential. A 204 response is followed by a second durable write clearing the pending marker. Reading and successful pairing are blocked until both steps finish. Older backends without the field are treated as already confirmed.

Confirmation is idempotent. Lost responses, temporary network errors, or failure to clear the local marker retain the saved grant; restart and the next `ensureBinding` retry confirmation before reading or refreshing. A permanent `invalid_grant` clears it. The server owns the fixed five-minute unconfirmed-grant deadline; retries must not extend it. Confirmed bindings have no total lifetime or idle timeout. Client-side claim retries retain the original pairing-code deadline because the client cannot infer a later server grant-creation time after a lost response.

Pairing cancellation explicitly revokes a newly received or locally pending grant. Cancellation racing with confirmation cannot restore removed local state or navigate as a successful pairing. A temporary confirmation failure is not cancellation and does not revoke the grant. No real credentials are used by the tests.

Legacy upgrade recovery is separate: an expired local legacy access credential is retained for one upgrade attempt rather than discarded, since the backend may already have successfully upgraded it before losing the response. The server accepts its recorded upgrade-recovery credential only within a fixed five-minute window after the first successful upgrade; retries do not extend that window. The first successful refresh destroys the old-bearer recovery material. Never-upgraded expired bindings and recovery attempts outside that window are rejected with `invalid_grant`. The server derives the upgrade refresh credential with a private random nonce and HMAC; it is not a publicly computable hash of the old access token. This recovery deadline does not expire the already confirmed device binding. Network failures retain the recoverable local state, while permanent rejection or an unavailable old-backend upgrade endpoint after expiry clears it. Legacy upgrades return confirmed bindings and do not require the five-minute initial-confirmation flow.


## Backend/client compatibility

| Client | Backend | Behavior |
| --- | --- | --- |
| New | Old | Missing `confirmation_required` means no confirmation step. An unavailable upgrade endpoint permits the still-valid legacy grant; after expiry the user pairs again. |
| New | New | Persist, confirm, then read. Existing valid legacy bindings upgrade with the bounded recovery window described above. |
| Old | New | New pairing cannot complete confirmation; reading remains blocked and the unconfirmed grant is destroyed after five minutes. Upgrade the client. The backend must not implicitly confirm or weaken the gate for old clients. |
| Old | Old | Original fixed-lifetime legacy behavior. |

A confirmed binding whose client still has a pending marker may retry confirmation after 24 hours or longer: the server returns 204, the client persists the cleared marker, then refreshes expired access. The five-minute deadline applies to never-confirmed new grants, not to confirmed bindings or this local recovery marker.
