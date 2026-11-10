import { describe, expect, test } from 'bun:test';
import { orderStatusOf } from './connector-kitchen-status';

describe('orderStatusOf', () => {
  test('follows the least advanced live line', () => {
    expect(orderStatusOf(['served', 'preparing', 'ready'])).toBe('preparing');
    expect(orderStatusOf(['ready', 'served'])).toBe('ready');
    expect(orderStatusOf(['served', 'served'])).toBe('served');
  });

  test('a line still waiting keeps the order accepted', () => {
    expect(orderStatusOf(['pending', 'served'])).toBe('pos_accepted');
  });

  test('cancelled lines do not hold the order back', () => {
    expect(orderStatusOf(['cancelled', 'served'])).toBe('served');
    expect(orderStatusOf(['cancelled', 'cancelled'])).toBe('cancelled');
  });
});
