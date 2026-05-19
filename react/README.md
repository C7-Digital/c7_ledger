# @c7-digital/react

React hooks for Daml ledger integration using Canton JSON API v2

## Features

- 🔧 **Type-safe**: Full TypeScript support with branded types from the Canton API
- ⚡ **Real-time**: WebSocket streaming for live contract updates
- 🎣 **React Hooks**: Modern React patterns — `useQuery`, `useStreamQuery`, `useMultiStreamQuery`, `useLedger`, `useUser`, `useReload`, `useRightsAs`
- 🔐 **OIDC auth**: Optional `AuthProvider` + `useAuth` (subpath `@c7-digital/react/auth`) — handles login redirect, silent token refresh, ledger-credentials derivation, and Keycloak-correct logout
- 📦 **Lightweight**: Minimal dependencies; OIDC dependencies are optional peer deps so consumers that only need ledger hooks don't pull them in
- **Replacement** for `@daml/react`.

## Two entrypoints

`@c7-digital/react` ships two import paths so the OIDC layer stays opt-in:

| Import path | What's there | Required peer deps |
|---|---|---|
| `@c7-digital/react` | `DamlLedger`, all ledger hooks (`useQuery`, `useStreamQuery`, …), ledger type re-exports | `@c7-digital/ledger`, `@daml/types`, `react` |
| `@c7-digital/react/auth` | `AuthProvider`, `useAuth`, `Credentials`, `createOidcConfig`, `oidcUserToLedgerAndCredentials` | + `react-oidc-context`, `oidc-client-ts` |

Pull from `/auth` only when you actually need OIDC; otherwise leave the OIDC peer deps uninstalled.

## Versioning

This package is versioned together with `@c7-digital/ledger` (the two travel as a pair). The peer dep is pinned to a compatible range; installing both at the same version is the simplest path.

Install the `@c7-digital/react` major/minor that matches the Canton spec your `@c7-digital/ledger` was built against.

## Installation

```bash
# Ledger hooks only
pnpm add @c7-digital/react @c7-digital/ledger @daml/types react

# With OIDC AuthProvider
pnpm add @c7-digital/react @c7-digital/ledger @daml/types react \
         react-oidc-context oidc-client-ts
```

## Build Output

The library builds to `dist/` with:

- `dist/index.js` — Main entry (ledger hooks)
- `dist/index.d.ts` — Main type declarations
- `dist/auth/index.js` — Auth subpath entry
- `dist/auth/index.d.ts` — Auth subpath types
- `dist/**/*.d.ts.map` — Source maps for debugging

## Quick Start

### 1. Setup the `DamlLedger` provider

Wrap the part of your tree that needs ledger access. The provider creates the underlying `Ledger` for you from `token` + `httpBaseUrl`, and hot-swaps the HTTP token in place when it changes — so refreshed access tokens (e.g. from OIDC silent renew) propagate without rebuilding queries.

```tsx
import { DamlLedger } from "@c7-digital/react";
import { lookupTemplate } from "@your-codegen-pkg";

function App({ token }: { token: string }) {
  return (
    <DamlLedger
      token={token}
      httpBaseUrl={window.location.origin}  // or "http://localhost:7575"
      versionedRegistry={lookupTemplate}
    >
      <MyComponent />
    </DamlLedger>
  );
}
```

### 2. Query active contracts

```tsx
import { useQuery } from "@c7-digital/react";
import { VerificationRequest } from "@your-codegen-pkg";

function MyComponent() {
  const { contracts, loading, error, reload } = useQuery(VerificationRequest);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  // Filter at the application level
  const exampleContracts = contracts.filter(
    c => c.payload.domain === "example.com",
  );

  return (
    <div>
      <h2>Verification Requests ({exampleContracts.length})</h2>
      {exampleContracts.map((c, i) => (
        <div key={i}>{c.payload.domain}</div>
      ))}
      <button onClick={reload}>Refresh</button>
    </div>
  );
}
```

### 3. Submit commands

```tsx
import { useLedger, useUser } from "@c7-digital/react";
import { VerificationRequest } from "@your-codegen-pkg";

function ApprovalButton({ contractId }: { contractId: string }) {
  const ledger = useLedger();
  const { user, loading, error } = useUser();

  const handleApprove = async () => {
    await ledger.exercise(
      VerificationRequest.AcceptRequest,
      contractId,
      { dnsTxtPayload: "domain-verification=abc123" },
      [user!.primaryParty!],
    );
  };

  if (loading) return <div>Loading user...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <button onClick={handleApprove}>Approve as {user?.userId}</button>;
}
```

### 4. Real-time streaming

```tsx
import { useStreamQuery } from "@c7-digital/react";
import { VerificationRequest } from "@your-codegen-pkg";

function LiveContracts() {
  const { contracts, loading, connected, error } = useStreamQuery(
    VerificationRequest,
  );

  return (
    <div>
      <div>Status: {connected ? "🟢 Connected" : "🔴 Disconnected"}</div>
      <div>Contracts: {contracts.length}</div>
      {contracts.map((c, i) => (
        <div key={i}>{JSON.stringify(c.payload)}</div>
      ))}
    </div>
  );
}
```

### 5. Stream multiple templates at once

`useMultiStreamQuery` opens a single WebSocket connection that fans out to several templates:

```tsx
import { useMultiStreamQuery } from "@c7-digital/react";
import { AddressBook, DomainOwnershipToken } from "@your-codegen-pkg";

function Dashboard() {
  const { contracts, loading, connected } = useMultiStreamQuery({
    addressBook: AddressBook,
    tokens: DomainOwnershipToken,
  });

  if (loading) return <div>Loading…</div>;
  return (
    <>
      <div>Address book: {contracts.addressBook.length}</div>
      <div>Tokens: {contracts.tokens.length}</div>
      <div>{connected ? "🟢" : "🔴"}</div>
    </>
  );
}
```

`useMultiStreamInterfaceQuery` works the same way for interfaces, and `useQueryInterface` / `useStreamQueryInterface` exist for single-interface scenarios.

### 6. Discover the rights of the logged-in user

```tsx
import { useRightsAs } from "@c7-digital/react";

function PartySwitcher() {
  const { actAsParties, readAsParties, loading } = useRightsAs();
  if (loading) return null;
  return (
    <select>
      {actAsParties.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}
```

### 7. OIDC authentication (optional)

When using Keycloak/Auth0/any OIDC IdP, wrap the app with `AuthProvider` and read credentials via `useAuth`. The provider:

- Runs the OIDC redirect flow (login / silent renew / logout-with-`id_token_hint`)
- Calls `Ledger.getTokenUserInfo()` to derive the user's primary party
- Persists credentials in `sessionStorage` so reloads don't kick the user back to login
- Mirrors refreshed access tokens into credentials — so the `<DamlLedger token={…}/>` below it keeps a live token without remounting
- Invalidates cached credentials when OIDC can't recover the session (refresh-token expiry, IdP session ended) or when the token's `exp` passes, so a stale `sessionStorage` blob can't keep the app "signed in" with a dead token

```tsx
import { AuthProvider, useAuth } from "@c7-digital/react/auth";
import { DamlLedger } from "@c7-digital/react";

function App() {
  return (
    <AuthProvider
      oidcAuthority="https://keycloak.example/realms/my-realm"
      oidcClientId="my-app"
      httpBaseUrl={window.location.origin}
      // Optional: Auth0-style audience query param
      // audience="https://canton.network.global"
    >
      <Shell />
    </AuthProvider>
  );
}

function Shell() {
  const { credentials, isLoading, isDerivingCredentials, logout } = useAuth();

  if (isLoading || isDerivingCredentials) return <div>Loading…</div>;
  if (!credentials) return <LoginScreen />;

  return (
    <DamlLedger
      token={credentials.token}
      httpBaseUrl={window.location.origin}
      versionedRegistry={lookupTemplate}
    >
      <Routes onLogout={logout} />
    </DamlLedger>
  );
}

function LoginScreen() {
  const { loginWithOidc } = useAuth();
  return <button onClick={loginWithOidc}>Sign in</button>;
}
```

For dev/test paths that need to inject credentials without going through OIDC, call `auth.setCredentials({...})` directly — useful for token-based admin logins or sandbox setups.

> `AuthProvider` is browser-only. Reads `window.sessionStorage`, `window.location`, and `window.history`; it throws a clear error if rendered server-side.

## API Reference

### Main entry — `@c7-digital/react`

#### `<DamlLedger>`

Provider that creates the underlying `Ledger` from its props and exposes it to all hooks below. Passes refreshed tokens through to the live `Ledger` so streams and queries stay authenticated.

```tsx
interface DamlLedgerProps extends LedgerOptions {
  children: ReactNode;
}
// LedgerOptions: { token, httpBaseUrl, versionedRegistry, … }
```

#### `useQuery(template, options?)`

```tsx
function useQuery<T, K>(
  template: Template<T, K>,
  options?: QueryOptions,
): QueryResult<T, K>;

interface QueryOptions {
  autoReload?: boolean;
}
interface QueryResult<TContract, TKey> {
  contracts: CreateEvent<TContract, TKey>[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}
```

#### `useStreamQuery(template, options?)`

Same shape as `useQuery` plus `connected: boolean`.

```tsx
interface StreamQueryResult<TContract, TKey> extends QueryResult<TContract, TKey> {
  connected: boolean;
}
```

#### `useMultiStreamQuery(templates)` / `useMultiStreamInterfaceQuery(interfaces)`

Stream several templates or interfaces over a single WebSocket. Pass a mapping `{ key: Template }`; receive `{ contracts: { key: CreateEvent[] }, loading, connected, error }`.

#### `useQueryInterface(interface, options?)` / `useStreamQueryInterface(interface, options?)`

Interface-variants of `useQuery` / `useStreamQuery`; return `InterfaceQueryResult` / `StreamQueryInterfaceResult`.

#### `useLedger()`

Returns the live `Ledger` instance for direct `create` / `exercise` / `submit` calls.

#### `useUser()`

```tsx
interface UserResult {
  user: User | null;
  loading: boolean;
  error: Error | null;
}
```

#### `useRightsAs(userId?)`

Resolves the rights of the supplied user (defaults to the token's `sub`) and returns `{ actAsParties, readAsParties, loading, error }`.

#### `useReload()`

Returns a function that triggers a fresh `Ledger` instance — useful when token rotation, network change, or explicit user action needs to invalidate all caches at once.

#### `createLedgerContext()`

Advanced. Build your own typed context if you need to host multiple isolated `<DamlLedger>` trees in the same app.

#### Re-exported ledger types

`Ledger`, `User`, `CreateEvent`, `ArchiveEvent`, `Event`, `Interface` — re-exported from `@c7-digital/ledger/lite` for one-import convenience.

### Auth entry — `@c7-digital/react/auth`

#### `<AuthProvider>`

```tsx
interface AuthProviderProps {
  oidcAuthority: string;
  oidcClientId: string;
  /** Base URL of the JSON Ledger API. Forwarded to credentials derivation. */
  httpBaseUrl: string;
  /** Optional audience query param (Auth0-style IdPs). */
  audience?: string;
  /** Override the sessionStorage key. Default: "auth_credentials". */
  storageKey?: string;
  /** Called after OIDC strips redirect params from the URL on the callback leg. */
  onSigninCallback?: () => void;
  children: React.ReactNode;
}
```

#### `useAuth()`

```tsx
interface AuthContextValue {
  credentials: Credentials | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isDerivingCredentials: boolean;
  error: Error | undefined;
  user: User | null | undefined;             // raw OIDC user (access_token, id_token, profile)
  loginWithOidc: () => void;                 // signinRedirect
  setCredentials: (c: Credentials | null) => void;  // dev / token-login path
  logout: () => void;                        // clears + signoutRedirect with id_token_hint
}
```

#### `Credentials`

```tsx
type Credentials = {
  party: string;
  token: string;
  user: User;  // result of Ledger.getTokenUserInfo()
  source?: "oidc" | "manual";  // who put them there; defaults to "manual"
};
```

`source` lets the provider tell OIDC-derived credentials apart from directly-injected ones. Only `"oidc"` credentials are dropped when the OIDC layer reports a dead session — `"manual"` (or `undefined`) credentials are preserved for dev/token-login flows. `oidcUserToLedgerAndCredentials` sets `source: "oidc"` for you; `setCredentials({...})` callers can leave it unset.

#### `createOidcConfig(authority, clientId, audience?)`

Low-level helper that returns the OIDC config object expected by `react-oidc-context`. `AuthProvider` calls this internally; expose it if you need to build the OIDC provider yourself.

#### `oidcUserToLedgerAndCredentials(user, httpBaseUrl)`

Low-level helper that exchanges a signed-in OIDC `User` for `{ ledger, credentials }`. Calls `Ledger.getTokenUserInfo()` under the hood to discover the user's primary party.

## Migration from `@daml/react`

| @daml/react        | @c7-digital/react              | Notes                                                                    |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------ |
| `DamlLedger`       | `DamlLedger`                   | Now takes `token` + `httpBaseUrl` directly; builds the `Ledger` for you  |
| `useLedger()`      | `useLedger()`                  | Returns `@c7-digital/ledger`'s typed `Ledger`                            |
| `useQuery()`       | `useQuery()`                   | Same shape; `template` argument instead of stringly-typed `templateId`   |
| `useStreamQuery()` | `useStreamQuery()`             | WebSocket-based; also `useMultiStreamQuery` for multi-template streams   |
| `useParty()`       | derive from `useUser()` / `useRightsAs()` | Party comes from the token; richer info via `useRightsAs`     |

## License

Apache-2.0
