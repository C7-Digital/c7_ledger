import { activeContractsRequest, interfaceFilter, templateFilter } from "./requests";

describe("activeContractsRequest", () => {
  it("puts the party filter in eventFormat, never in the deprecated top-level filter", () => {
    const body = activeContractsRequest(["alice::1220"], [templateFilter("#pkg:Mod:T")], 42);
    expect(body).toEqual({
      verbose: false,
      activeAtOffset: 42,
      eventFormat: {
        filtersByParty: {
          "alice::1220": {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: { templateId: "#pkg:Mod:T", includeCreatedEventBlob: false },
                  },
                },
              },
            ],
          },
        },
        verbose: false,
      },
    });
    expect("filter" in body).toBe(false);
  });

  it("gives every party the same filters, as an OR over them", () => {
    const filters = [templateFilter("#a:M:A", true), interfaceFilter("#i:M:I")];
    const body = activeContractsRequest(["p1", "p2"], filters, 7, true);
    expect(Object.keys(body.eventFormat!.filtersByParty!)).toEqual(["p1", "p2"]);
    expect(body.eventFormat!.filtersByParty!["p2"]!.cumulative).toEqual([
      { identifierFilter: filters[0] },
      { identifierFilter: filters[1] },
    ]);
    expect(body.eventFormat!.verbose).toBe(true);
  });
});

describe("filter builders", () => {
  it("templateFilter asks for no created-event blob by default", () => {
    expect(templateFilter("#pkg:Mod:T")).toEqual({
      TemplateFilter: { value: { templateId: "#pkg:Mod:T", includeCreatedEventBlob: false } },
    });
  });

  it("interfaceFilter always asks for the interface view", () => {
    expect(interfaceFilter("#pkg:Mod:I", true)).toEqual({
      InterfaceFilter: {
        value: { interfaceId: "#pkg:Mod:I", includeInterfaceView: true, includeCreatedEventBlob: true },
      },
    });
  });
});
