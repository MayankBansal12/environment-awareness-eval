export class AuditLog {
  constructor() {
    this.log = [];
  }

  record(entry) {
    this.log.push(structuredClone(entry));
  }

  entries() {
    return this.log.map((entry) => structuredClone(entry));
  }
}
