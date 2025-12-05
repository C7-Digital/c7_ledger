// Basic tests for the new ledger implementation
import { Ledger, createCmd, createAndExerciseCmd, exerciseCmd } from "./ledger";

// Valid JWT token for testing with sub field
// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"test-user","iat":1516239022}
const TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("Ledger", () => {
  it("should create a ledger instance with default options", () => {
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://localhost:7575",
    });

    expect(ledger).toBeInstanceOf(Ledger);
  });

  it("should create a ledger instance with custom options", () => {
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://example.com:8080",
      wsBaseUrl: "ws://example.com:8080",
    });

    expect(ledger).toBeInstanceOf(Ledger);
  });

  it("should handle discriminant union commands", () => {
    // Example of how the discriminant union works with convenience constructors
    const create = createCmd('TestModule:TestTemplate', { field: 'value' });
    const exercise = exerciseCmd(
      'TestModule:TestTemplate',
      'test-contract-id' as any,
      'TestChoice' as any,
      { arg: 'value' }
    );
    const createAndExercise = createAndExerciseCmd(
      'TestModule:TestTemplate',
      { field: 'value' },
      'TestChoice' as any,
      { arg: 'value' }
    );

    // TypeScript should correctly infer the types
    expect(create.type).toBe('create');
    expect(exercise.type).toBe('exercise');
    expect(createAndExercise.type).toBe('createAndExercise');

    // Verify the structure
    expect(create.templateId).toBe('TestModule:TestTemplate');
    expect(create.payload).toEqual({ field: 'value' });
    expect(exercise.contractId).toBe('test-contract-id');
    expect(createAndExercise.choice).toBe('TestChoice');
  });
});
