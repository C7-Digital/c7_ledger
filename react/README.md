# @c7/react

React hooks for Daml ledger integration using Canton JSON API v2

## Features

- 🔧 **Type-safe**: Full TypeScript support with branded types from Canton API
- ⚡ **Real-time**: WebSocket streaming for live contract updates
- 🎣 **React Hooks**: Modern React patterns with hooks for ledger operations
- 📦 **Lightweight**: Minimal dependencies
- **Replacement**: `@daml/react`.

## Versioning

This package follows the Canton SDK versioning scheme, matching the `@c7/ledger` package it depends on.

**Current version**: `3.3.0-snapshot.20250507.0`

- Versioned to match the Canton SDK and `@c7/ledger` package
- Ensures compatibility with the specific Canton OpenAPI types
- When Canton releases a new version, both packages will be updated together

**Version compatibility**: Install the version that matches your Canton participant node version.

## Installation

```bash
pnpm install @c7/react @c7/ledger
```

## Build Output

The library builds to the `dist/` folder with:

- `dist/index.js` - Main entry point
- `dist/index.d.ts` - TypeScript declarations
- `dist/**/*.d.ts.map` - Source maps for debugging

## Quick Start

### 1. Setup the Provider

Wrap your app with `DamlLedger` provider:

```tsx
import { DamlLedger } from "@c7/react";
import { Ledger } from "@c7/ledger";

const ledger = new Ledger({
  baseUrl: "http://localhost:7575",
  token: "your-jwt-token",
  party: "Alice::1220...",
});

function App() {
  return (
    <DamlLedger ledger={ledger} party="Alice::1220...">
      <MyComponent />
    </DamlLedger>
  );
}
```

### 2. Query Contracts

Use `useQuery` to fetch active contracts:

```tsx
import { useQuery } from "@c7/react";

function MyComponent() {
  const { contracts, loading, error, reload } = useQuery(
    "#domain-verification-model:InternetDomainName:VerificationRequest"
  );

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  // Filter contracts at the application level
  const exampleContracts = contracts.filter(contract => contract.domain === "example.com");

  return (
    <div>
      <h2>Verification Requests ({exampleContracts.length})</h2>
      {exampleContracts.map((contract, i) => (
        <div key={i}>{contract.domain}</div>
      ))}
      <button onClick={reload}>Refresh</button>
    </div>
  );
}
```

### 3. Submit Commands

Use `useLedger` to get the ledger instance and `useUser` for the current user information:

```tsx
import { useLedger, useUser } from "@c7/react";

function ApprovalComponent({ contractId }: { contractId: string }) {
  const ledger = useLedger();
  const { user, loading, error } = useUser();

  const handleApprove = async () => {
    try {
      await ledger.exercise({
        templateId: "#domain-verification-model:InternetDomainName:VerificationRequest",
        contractId,
        choice: "AcceptRequest",
        choiceArgument: {
          dnsTxtPayload: "domain-verification=abc123",
        },
      });
    } catch (error) {
      console.error("Failed to approve:", error);
    }
  };

  if (loading) return <div>Loading user...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <button onClick={handleApprove}>Approve Request (as {user?.userId})</button>;
}
```

### 4. Real-time Streaming

Use `useStreamQuery` for live updates:

```tsx
import { useStreamQuery } from "@c7/react";

function LiveContracts() {
  const { contracts, loading, connected, error } = useStreamQuery(
    "#domain-verification-model:InternetDomainName:VerificationRequest"
  );

  return (
    <div>
      <div>Status: {connected ? "🟢 Connected" : "🔴 Disconnected"}</div>
      <div>Contracts: {contracts.length}</div>
      {contracts.map((contract, i) => (
        <div key={i}>{JSON.stringify(contract)}</div>
      ))}
    </div>
  );
}
```

## API Reference

### Components

#### `DamlLedger`

Provider component that enables ledger hooks.

```tsx
interface DamlLedgerProps {
  ledger: Ledger;
  party: string;
  children: ReactNode;
}
```

### Hooks

#### `useQuery(templateId, options?)`

Query active contracts for a template.

```tsx
function useQuery<T>(templateId: string, options?: QueryOptions): QueryResult<T>;

interface QueryOptions {
  autoReload?: boolean;
}

interface QueryResult<T> {
  contracts: T[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}
```

#### `useLedger()`

Get the ledger instance.

```tsx
function useLedger(): Ledger;
```

#### `useUser()`

Get the current user information from the token.

```tsx
function useUser(): UserResult;

interface UserResult {
  user: User | null;
  loading: boolean;
  error: Error | null;
}
```

#### `useStreamQuery(templateId, options?)`

Stream active contracts with real-time updates.

```tsx
function useStreamQuery<T>(templateId: string, options?: QueryOptions): StreamQueryResult<T>;

interface StreamQueryResult<T> extends QueryResult<T> {
  connected: boolean;
}
```

#### `useStreamQueries(templateIds, options?)`

Stream multiple templates simultaneously.

```tsx
function useStreamQueries<T>(templateIds: string[], options?: QueryOptions): StreamQueryResult<T>;
```

#### `useReload()`

Get a function to reload all queries.

```tsx
function useReload(): () => void;
```

## Migration from @daml/react

This package provides a compatible API with `@daml/react` but uses the newer Canton JSON API v2:

| @daml/react        | @c7/react            | Notes                          |
| ------------------ | -------------------- | ------------------------------ |
| `DamlLedger`       | `DamlLedger`         | Same API, different backend    |
| `useParty()`       | `useParty()`         | Identical                      |
| `useLedger()`      | `useLedger()`        | Enhanced with typed operations |
| `useQuery()`       | `useQuery()`         | Improved filtering and caching |
| `useStreamQuery()` | `useStreamQuery()`   | Real-time WebSocket updates    |

## License

Apache-2.0
