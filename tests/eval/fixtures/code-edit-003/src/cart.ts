export type CartItem = { id: string; name: string; qty: number };

export class Cart {
  constructor(private readonly items: CartItem[] = []) {}

  addItem(item: CartItem): Cart {
    return new Cart([...this.items, item]);
  }

  list(): CartItem[] {
    return [...this.items];
  }

  // TODO: removeItem(id: string): Cart
}
