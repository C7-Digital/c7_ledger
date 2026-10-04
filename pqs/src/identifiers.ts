/**
 * Derive PQS entity/choice identifiers from Daml codegen objects.
 *
 * PQS names a template as `package:Module:Entity` and a choice as
 * `package:Module:Entity:Choice`, using the package NAME. The codegen
 * `templateId` is `#<package-name>:Module:Entity` (the `#` is Daml 3.x
 * package-name reference syntax), so the template name is that identifier with
 * the leading `#` removed, and a choice name appends the choice to it.
 */

import type { Choice, Template } from "@daml/types";

import type { ChoiceName, TemplateName } from "./types.js";

/** Drop the Daml `#` package-name marker; PQS names carry no prefix. */
function stripMarker(id: string): string {
  return id.startsWith("#") ? id.slice(1) : id;
}

/**
 * The PQS name for a template — from a codegen `Template` object or a raw
 * `package:Module:Entity` string. Phantom-typed by the template payload.
 */
export function templateName<T extends object>(
  // `any` for the key type param matches how the Daml codegen emits templates
  // (`Template<T, undefined, "#pkg:Mod:Ent">`) — `Template` is invariant in that
  // param, so `unknown` would reject the codegen object. We never use the key.
  template: Template<T, any, string> | string,
): TemplateName<T> {
  const id = typeof template === "string" ? template : template.templateId;
  return stripMarker(id) as TemplateName<T>;
}

/**
 * The PQS name for a choice — from a codegen `Choice` object or a raw
 * `package:Module:Entity:Choice` string. Phantom-typed by the choice
 * argument/result.
 *
 * A choice FQN is the full name of the template it is defined on, with the
 * choice appended: `package:Module:Entity:Choice`. `Choice.template()` gives
 * that template, whose id (marker stripped) is `package:Module:Entity`.
 */
export function choiceName<T extends object, C, R>(
  choice: Choice<T, C, R, any> | string,
): ChoiceName<C, R> {
  if (typeof choice === "string") {
    return stripMarker(choice) as ChoiceName<C, R>;
  }
  const template = stripMarker(choice.template().templateId);
  return `${template}:${choice.choiceName}` as ChoiceName<C, R>;
}
