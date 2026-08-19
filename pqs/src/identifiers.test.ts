import type { Choice, Template } from "@daml/types";

import { choiceName, templateName } from "./identifiers.js";

describe("templateName", () => {
  it("strips the Daml package-name marker from a codegen templateId", () => {
    const template = {
      templateId: "#splice-amulet:Splice.Amulet:Amulet",
    } as unknown as Template<object>;
    expect(templateName(template)).toBe("splice-amulet:Splice.Amulet:Amulet");
  });

  it("passes a raw name through, with or without the marker", () => {
    expect(templateName("#pkg:Mod:Ent")).toBe("pkg:Mod:Ent");
    expect(templateName("pkg:Mod:Ent")).toBe("pkg:Mod:Ent");
  });
});

describe("choiceName", () => {
  it("appends the choice to its template's full name (package:Module:Entity:Choice)", () => {
    const choice = {
      choiceName: "AmuletRules_Transfer",
      template: () => ({ templateId: "#splice-amulet:Splice.AmuletRules:AmuletRules" }),
    } as unknown as Choice<object, unknown, unknown>;
    expect(choiceName(choice)).toBe(
      "splice-amulet:Splice.AmuletRules:AmuletRules:AmuletRules_Transfer",
    );
  });

  it("passes a raw choice name through, with or without the marker", () => {
    expect(choiceName("pkg:Mod:Ent:Choice")).toBe("pkg:Mod:Ent:Choice");
    expect(choiceName("#pkg:Mod:Ent:Choice")).toBe("pkg:Mod:Ent:Choice");
  });
});
