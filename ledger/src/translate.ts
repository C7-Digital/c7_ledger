import { UserRight } from "./types";
import { components } from "./generated/api";

type Schemas = components["schemas"];

export function userRights(right: Schemas["Right"]): UserRight {
  const kind = right.kind;
  if (!kind) {
    throw new Error(`Right has no kind: ${JSON.stringify(right)}`);
  }
  if ("CanActAs" in kind) {
    return {
      type: "canActAs",
      party: kind.CanActAs.value.party,
    };
  } else if ("CanReadAs" in kind) {
    return {
      type: "canReadAs",
      party: kind.CanReadAs.value.party,
    };
  } else if ("CanReadAsAnyParty" in kind) {
    return { type: "canReadAsAnyParty" };
  } else if ("Empty" in kind) {
    return { type: "empty" };
  } else if ("IdentityProviderAdmin" in kind) {
    return { type: "identityProviderAdmin" };
  } else if ("ParticipantAdmin" in kind) {
    return { type: "participantAdmin" };
  } else {
    throw new Error(`Unknown right kind: ${JSON.stringify(right)}`);
  }
}
