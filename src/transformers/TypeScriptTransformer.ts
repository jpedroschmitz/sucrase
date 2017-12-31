import ImportProcessor from "../ImportProcessor";
import TokenProcessor from "../TokenProcessor";
import isIdentifier from "../util/isIdentifier";
import RootTransformer from "./RootTransformer";
import Transformer from "./Transformer";

export default class TypeScriptTransformer extends Transformer {
  constructor(
    readonly rootTransformer: RootTransformer,
    readonly tokens: TokenProcessor,
    readonly importProcessor: ImportProcessor,
  ) {
    super();
  }

  preprocess(): void {
    this.importProcessor.pruneTypeOnlyImports();
  }

  process(): boolean {
    // We need to handle all classes specially in order to remove `implements`.
    if (this.tokens.matchesKeyword("class")) {
      this.rootTransformer.processClass();
      return true;
    }
    const processedTypeAnnotation = this.rootTransformer.processPossibleTypeAnnotation();
    if (processedTypeAnnotation) {
      return true;
    }
    if (this.tokens.currentToken().contextName === "type") {
      this.tokens.removeInitialToken();
      while (this.tokens.currentToken().contextName === "type") {
        this.tokens.removeToken();
      }
      return true;
    }
    if (this.tokens.currentToken().contextName === "typeParameter") {
      this.tokens.removeInitialToken();
      while (this.tokens.currentToken().contextName === "typeParameter") {
        this.tokens.removeToken();
      }
      return true;
    }
    if (
      this.tokens.matchesName("public") ||
      this.tokens.matchesName("protected") ||
      this.tokens.matchesName("private") ||
      this.tokens.matchesName("abstract") ||
      this.tokens.matchesName("readonly")
    ) {
      this.tokens.removeInitialToken();
      return true;
    }
    if (this.isNonNullAssertion()) {
      this.tokens.removeInitialToken();
      return true;
    }
    if (this.tokens.matchesName("enum")) {
      this.processEnum();
      return true;
    }
    return false;
  }

  /**
   * This is either a negation operator or a non-null assertion operator. If it's a non-null
   * assertion, get rid of it.
   */
  isNonNullAssertion(): boolean {
    if (!this.tokens.matches(["!"])) {
      return false;
    }
    let index = this.tokens.currentIndex() - 1;
    // Walk left past all operators that might be either prefix or postfix operators.
    while (
      this.tokens.matchesAtIndex(index, ["!"]) ||
      this.tokens.matchesAtIndex(index, ["++"]) ||
      this.tokens.matchesAtIndex(index, ["--"])
    ) {
      index--;
    }
    if (index < 0) {
      return false;
    }
    const prevToken = this.tokens.tokens[index];
    // Bias toward keeping the token; if we remove it incorrectly, the code will have a subtle bug,
    // while if we don't remove it and we need to, the code will have a syntax error.
    if (
      [
        "name",
        "num",
        "string",
        "false",
        "true",
        "null",
        "void",
        "this",
        ")",
        "]",
        "}",
        "`",
      ].includes(prevToken.type.label)
    ) {
      return true;
    }
    return false;
  }

  processEnum(): void {
    this.tokens.removeInitialToken();
    const enumName = this.tokens.currentToken().value;
    this.tokens.removeToken();
    this.tokens.appendCode(`var ${enumName}; (function (${enumName})`);
    this.tokens.copyExpectedToken("{");
    this.processEnumBody(enumName);
    this.tokens.copyExpectedToken("}");
    this.tokens.appendCode(`)(${enumName} || (${enumName} = {}));`);
  }

  /**
   * Rather than try to compute the actual enum values at compile time, we just create variables for
   * each one and let everything evaluate at runtime. There's some additional complexity due to
   * handling string literal names, including ones that happen to be valid identifiers.
   */
  processEnumBody(enumName: string): void {
    let isPreviousValidIdentifier = false;
    let lastValueReference = null;
    while (true) {
      if (this.tokens.matches(["}"])) {
        break;
      }
      const nameToken = this.tokens.currentToken();
      let name;
      let isValidIdentifier;
      let nameStringCode;
      if (nameToken.type.label === "name") {
        name = nameToken.value;
        isValidIdentifier = true;
        nameStringCode = `"${name}"`;
      } else if (nameToken.type.label === "string") {
        name = nameToken.value;
        isValidIdentifier = isIdentifier(name);
        nameStringCode = this.tokens.code.slice(nameToken.start, nameToken.end);
      } else {
        throw new Error("Expected name or string at beginning of enum element.");
      }
      this.tokens.removeInitialToken();

      let valueIsString;
      let valueCode;

      if (this.tokens.matches(["="])) {
        const contextStartIndex = this.tokens.currentToken().contextStartIndex!;
        this.tokens.removeToken();
        if (this.tokens.matches(["string", ","]) || this.tokens.matches(["string", "}"])) {
          valueIsString = true;
        }
        const startToken = this.tokens.currentToken();
        while (
          !this.tokens.matchesContextEnd(",", contextStartIndex) &&
          !this.tokens.matchesContextEnd("}", contextStartIndex)
        ) {
          this.tokens.removeToken();
        }
        valueCode = this.tokens.code.slice(
          startToken.start,
          this.tokens.tokenAtRelativeIndex(-1).end,
        );
      } else {
        valueIsString = false;
        if (lastValueReference != null) {
          if (isPreviousValidIdentifier) {
            valueCode = `${lastValueReference} + 1`;
          } else {
            valueCode = `(${lastValueReference}) + 1`;
          }
        } else {
          valueCode = "0";
        }
      }
      if (this.tokens.matches([","])) {
        this.tokens.removeToken();
      }

      let valueReference;
      if (isValidIdentifier) {
        this.tokens.appendCode(`const ${name} = ${valueCode}; `);
        valueReference = name;
      } else {
        valueReference = valueCode;
      }

      if (valueIsString) {
        this.tokens.appendCode(`${enumName}[${nameStringCode}] = ${valueReference};`);
      } else {
        this.tokens.appendCode(
          `${enumName}[${enumName}[${nameStringCode}] = ${valueReference}] = ${nameStringCode};`,
        );
      }
      lastValueReference = valueReference;
      isPreviousValidIdentifier = isValidIdentifier;
    }
  }
}