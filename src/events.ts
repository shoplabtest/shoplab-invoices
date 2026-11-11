export const EXCHANGE = 'shop.events';

/** Subset of shoplab-contracts events/order.placed.schema.json that this service reads. */
export interface OrderPlaced {
  orderId: string;
  userId: string;
  total: number;
  currency: string;
  lines: { productId: string; quantity: number; unitPrice?: number | null }[];
  placedAt: string;
}
