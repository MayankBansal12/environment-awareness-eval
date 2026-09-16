export class Stock {
  constructor(levels) {
    this.levels = levels.map((level) => ({ ...level, held: level.held ?? 0 }));
  }

  level(sku, warehouse) {
    return this.levels.find((level) => level.sku === sku && level.warehouse === warehouse);
  }

  forSku(sku) {
    return this.levels.filter((level) => level.sku === sku);
  }
}
