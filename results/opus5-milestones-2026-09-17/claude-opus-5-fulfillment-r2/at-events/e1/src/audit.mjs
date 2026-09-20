export class AuditLog {
  constructor() {
    this.log = [];
  }

  record(entry) {
    this.log.push(entry);
  }

  entries() {
    return this.log;
  }
}
