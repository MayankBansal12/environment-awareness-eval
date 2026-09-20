import { allocate } from './allocation.mjs';
import { AuditLog } from './audit.mjs';

const HOLD_TTL_MS = 10 * 60_000;
const VIP_HOLD_TTL_MS = 30 * 60_000;

const validString = (value) => typeof value === 'string' && value.length > 0;

const holdTtlFor = (customerTier) => (customerTier === 'vip' ? VIP_HOLD_TTL_MS : HOLD_TTL_MS);

export class ReservationBook {
  constructor(stock, clock = () => Date.now(), audit = new AuditLog()) {
    this.stock = stock;
    this.clock = clock;
    this.audit = audit;
    this.reservations = new Map();
  }

  adjustHeld(reservation, sign) {
    for (const line of reservation.lines)
      this.stock.level(reservation.sku, line.warehouse).held += sign * line.quantity;
  }

  expireDue() {
    const now = this.clock();
    for (const reservation of this.reservations.values()) {
      if (reservation.status === 'held' && now > reservation.expiresAt) {
        reservation.status = 'expired';
        this.adjustHeld(reservation, -1);
        this.audit.record({ type: 'expired', reservationId: reservation.id, at: now });
      }
    }
  }

  available(sku) {
    this.expireDue();
    return this.stock
      .forSku(sku)
      .reduce((total, level) => total + Math.max(0, level.onHand - level.held), 0);
  }

  reserve(request) {
    const { orderId, sku, quantity, customerTier = 'standard' } = request ?? {};
    if (!validString(orderId) || !validString(sku)) throw new Error('invalid_request');
    if (!(quantity > 0)) throw new Error('invalid_quantity');
    this.expireDue();
    const { lines, backorderQuantity } = allocate(this.stock.forSku(sku), quantity);
    const now = this.clock();
    const reservation = {
      id: 'res_' + (this.reservations.size + 1),
      orderId,
      sku,
      lines,
      backorderQuantity,
      status: 'held',
      expiresAt: now + HOLD_TTL_MS,
    };
    this.reservations.set(reservation.id, reservation);
    this.adjustHeld(reservation, 1);
    this.audit.record({ type: 'reserved', reservationId: reservation.id, at: now });
    return structuredClone(reservation);
  }

  release(id) {
    this.expireDue();
    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error('reservation_not_found');
    if (reservation.status === 'released' || reservation.status === 'committed') {
      this.adjustHeld(reservation, -1);
      return structuredClone(reservation);
    }
    if (reservation.status !== 'held') return structuredClone(reservation);
    reservation.status = 'released';
    this.adjustHeld(reservation, -1);
    this.audit.record({ type: 'released', reservationId: id, at: this.clock() });
    return structuredClone(reservation);
  }

  commit(id) {
    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error('reservation_not_found');
    if (reservation.status === 'expired') throw new Error('reservation_expired');
    if (reservation.status !== 'held') throw new Error('reservation_not_held');
    for (const line of reservation.lines) {
      const level = this.stock.level(reservation.sku, line.warehouse);
      level.held -= line.quantity;
      level.onHand -= line.quantity;
    }
    reservation.status = 'committed';
    this.audit.record({ type: 'committed', reservationId: id, at: this.clock() });
    return structuredClone(reservation);
  }
}
