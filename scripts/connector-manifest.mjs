const pluginIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const pluginVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const connectorFieldTypes = new Set([
  "text",
  "password",
  "url",
  "select",
  "number",
  "checkbox",
]);

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object.");
  }
}

function assertString(value, label, { min = 0, max, trim = false, pattern } = {}) {
  if (typeof value !== "string") {
    throw new Error(label + " must be a string.");
  }

  const checkedValue = trim ? value.trim() : value;
  if (checkedValue.length < min || (max !== undefined && checkedValue.length > max)) {
    throw new Error(label + " length is invalid.");
  }
  if (pattern && !pattern.test(checkedValue)) {
    throw new Error(label + " format is invalid.");
  }
}

function assertOptionalString(value, label, options) {
  if (value !== undefined) {
    assertString(value, label, options);
  }
}

function assertOptionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(label + " must be a boolean.");
  }
}

function assertOptionalFiniteNumber(value, label) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(label + " must be a finite number.");
  }
}

function assertConnectorFieldValue(value, label) {
  if (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 4000)
  ) {
    return;
  }

  throw new Error(label + " is not a valid connector field value.");
}

function assertConnectionField(field, index) {
  const label = "connectionFields[" + index + "]";
  assertRecord(field, label);
  assertString(field.id, label + ".id", { min: 1, max: 120, trim: true });
  assertString(field.label, label + ".label", { min: 1, max: 120, trim: true });

  if (typeof field.type !== "string" || !connectorFieldTypes.has(field.type)) {
    throw new Error(label + ".type is invalid.");
  }

  assertOptionalString(field.placeholder, label + ".placeholder", {
    max: 240,
    trim: true,
  });
  assertOptionalString(field.helpText, label + ".helpText", {
    max: 500,
    trim: true,
  });
  assertOptionalBoolean(field.required, label + ".required");
  assertOptionalBoolean(field.secret, label + ".secret");

  if (field.defaultValue !== undefined) {
    assertConnectorFieldValue(field.defaultValue, label + ".defaultValue");
  }

  if (field.options !== undefined) {
    if (!Array.isArray(field.options) || field.options.length > 50) {
      throw new Error(label + ".options is invalid.");
    }

    field.options.forEach((option, optionIndex) => {
      const optionLabel = label + ".options[" + optionIndex + "]";
      assertRecord(option, optionLabel);
      assertString(option.value, optionLabel + ".value", { min: 1, max: 120 });
      assertString(option.label, optionLabel + ".label", { min: 1, max: 120 });
    });
  }

  assertOptionalFiniteNumber(field.min, label + ".min");
  assertOptionalFiniteNumber(field.max, label + ".max");
  assertOptionalFiniteNumber(field.step, label + ".step");
}

export function assertConnectorPluginManifest(manifest) {
  assertRecord(manifest, "Connector manifest");
  assertString(manifest.id, "Connector manifest id", {
    min: 1,
    max: 120,
    trim: true,
    pattern: pluginIdPattern,
  });
  assertString(manifest.version, "Connector manifest version", {
    min: 1,
    trim: true,
    pattern: pluginVersionPattern,
  });

  if (manifest.apiVersion !== 2) {
    throw new Error("Connector manifest API version must be 2.");
  }

  assertRecord(manifest.capabilities, "Connector manifest capabilities");
  const capabilityNames = Object.keys(manifest.capabilities);
  if (
    !capabilityNames.includes("connector") ||
    capabilityNames.some((name) => name !== "connector" && name !== "codeHost")
  ) {
    throw new Error(
      "Connector manifest capabilities must declare connector and may also declare codeHost.",
    );
  }
  for (const name of capabilityNames) {
    assertRecord(manifest.capabilities[name], "Connector manifest capabilities." + name);
  }

  assertString(manifest.displayName, "Connector manifest displayName", {
    min: 1,
    max: 120,
    trim: true,
  });
  assertOptionalString(manifest.description, "Connector manifest description", {
    max: 500,
    trim: true,
  });
  assertString(manifest.iconSvg, "Connector manifest iconSvg", {
    min: 1,
    max: 20000,
  });
  assertString(manifest.entrypoint, "Connector manifest entrypoint", {
    min: 1,
    max: 240,
    trim: true,
  });

  if (
    !Array.isArray(manifest.connectionFields) ||
    manifest.connectionFields.length < 1 ||
    manifest.connectionFields.length > 50
  ) {
    throw new Error("Connector manifest connectionFields must contain 1 to 50 fields.");
  }

  manifest.connectionFields.forEach(assertConnectionField);
  return manifest;
}
