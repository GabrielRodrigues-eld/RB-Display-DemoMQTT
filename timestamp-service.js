(function createTimestampService() {
  const CONFIG = window.FACTORY_DEMO_CONFIG;
  const offsetMs = CONFIG.timestamp.offsetMinutes * 60 * 1000;

  function create(nowMs = Date.now()) {
    if (!Number.isFinite(nowMs)) throw new TypeError("O instante deve ser um número finito.");

    const digits = CONFIG.timestamp.fractionalDigits;
    if (!Number.isInteger(digits) || digits < 0 || digits > 3) {
      throw new RangeError("fractionalDigits deve estar entre 0 e 3.");
    }

    const iso = new Date(nowMs + offsetMs).toISOString();
    if (digits === 0) return iso.replace(/\.\d{3}Z$/, "Z");
    return iso.replace(/\.(\d{3})Z$/, (_match, fraction) => `.${fraction.slice(0, digits)}Z`);
  }

  function pattern() {
    const digits = CONFIG.timestamp.fractionalDigits;
    const fraction = digits ? `\\.\\d{${digits}}` : "";
    return new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}${fraction}Z$`);
  }

  function isValid(value) {
    return typeof value === "string" && pattern().test(value) && !Number.isNaN(Date.parse(value));
  }

  window.FactoryTimestamp = Object.freeze({
    create,
    isValid,
  });
})();
