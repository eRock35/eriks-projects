/* Canon - the example. A MADE-UP shop, Fernhill Coffee Co., with five metric
 * definitions, schema notes, and three AI answers to check: one that counts
 * refunds and test orders, one whose join counts every order once per line,
 * and one that is right. Every name and number here is invented; the page
 * labels it "made-up example" everywhere it appears.
 *
 * UMD like the core: window.CanonDemo in the page, require() in the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CanonDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function canon() {
    return {
      version: 1,
      name: 'Fernhill Coffee Co.',
      sample: true,
      updatedAt: 0,
      metrics: [
        {
          id: 'revenue',
          name: 'Revenue',
          synonyms: ['sales', 'net sales', 'GMV', 'takings', 'turnover'],
          meaning: 'Money we kept from paid orders: what each line sold for after discounts, before tax and shipping, minus anything refunded. Staff test orders never count.',
          owner: 'Priya, Finance',
          tables: ['order_lines', 'orders'],
          measure: 'SUM(order_lines.net_amount)',
          filters: [
            { sql: "orders.status = 'paid'", keepsOut: 'unpaid orders' },
            { sql: 'order_lines.refunded_at IS NULL', keepsOut: 'refunds' },
            { sql: 'orders.is_test = false', keepsOut: 'test orders' },
          ],
          date: { column: 'orders.paid_at', tz: 'America/New_York' },
          grain: 'one row per order line',
          dimensions: ['orders.channel', 'products.category', 'customers.region'],
          traps: 'orders.total includes tax and shipping and is one number per order - never add it up next to order lines. created_at is when the cart was made, not when it was paid.',
        },
        {
          id: 'orders',
          name: 'Orders',
          synonyms: ['order count', 'number of orders', 'purchases', 'transactions'],
          meaning: 'Paid orders, counted once each - an order with three bags of beans is one order.',
          owner: 'Sam, Operations',
          tables: ['orders'],
          measure: 'COUNT(DISTINCT orders.id)',
          filters: [
            { sql: "orders.status = 'paid'", keepsOut: 'unpaid orders' },
            { sql: 'orders.is_test = false', keepsOut: 'test orders' },
          ],
          date: { column: 'orders.paid_at', tz: 'America/New_York' },
          grain: 'one row per order',
          dimensions: ['orders.channel', 'customers.region'],
          traps: 'Joining order_lines to filter by product multiplies orders - count DISTINCT orders.id.',
        },
        {
          id: 'active-customers',
          name: 'Active customers',
          synonyms: ['active users', 'active buyers', 'unique customers', 'paying customers', 'customer count'],
          meaning: 'Different customers with at least one paid, non-test order in the period.',
          owner: 'Ana, Growth',
          tables: ['orders'],
          measure: 'COUNT(DISTINCT orders.customer_id)',
          filters: [
            { sql: "orders.status = 'paid'", keepsOut: 'unpaid orders' },
            { sql: 'orders.is_test = false', keepsOut: 'test orders' },
          ],
          date: { column: 'orders.paid_at', tz: 'America/New_York' },
          grain: 'one row per customer',
          dimensions: ['customers.region', 'orders.channel'],
          traps: 'A customer who buys in two months is active in both - never add monthly numbers up into a quarter.',
        },
        {
          id: 'average-order-value',
          name: 'Average order value',
          synonyms: ['AOV', 'avg order value', 'average basket', 'basket size'],
          meaning: 'Revenue divided by the number of paid orders.',
          owner: 'Priya, Finance',
          tables: ['order_lines', 'orders'],
          measure: 'SUM(order_lines.net_amount) / COUNT(DISTINCT orders.id)',
          filters: [
            { sql: "orders.status = 'paid'", keepsOut: 'unpaid orders' },
            { sql: 'orders.is_test = false', keepsOut: 'test orders' },
            { sql: 'order_lines.refunded_at IS NULL', keepsOut: 'refunds' },
          ],
          date: { column: 'orders.paid_at', tz: 'America/New_York' },
          grain: 'one row per order',
          dimensions: ['orders.channel', 'customers.region'],
          traps: 'Not AVG(orders.total) - that includes tax and shipping. Count orders with DISTINCT: the lines are joined in.',
        },
        {
          id: 'refund-rate',
          name: 'Refund rate',
          synonyms: ['refund %', 'refund ratio', 'return rate', 'share refunded'],
          meaning: 'The share of paid sales money that was later refunded, weighted by amount rather than by number of orders.',
          owner: 'Priya, Finance',
          tables: ['order_lines', 'orders'],
          measure: 'SUM(CASE WHEN order_lines.refunded_at IS NOT NULL THEN order_lines.net_amount ELSE 0 END) / SUM(order_lines.net_amount)',
          filters: [
            { sql: "orders.status = 'paid'", keepsOut: 'unpaid orders' },
            { sql: 'orders.is_test = false', keepsOut: 'test orders' },
          ],
          date: { column: 'orders.paid_at', tz: 'America/New_York' },
          grain: 'one row per order line',
          dimensions: ['orders.channel', 'products.category'],
          traps: 'Refunds are dated by the order’s paid_at, not by refunded_at, so a quarter’s rate keeps settling for a few weeks.',
        },
      ],
      tables: [
        { name: 'customers', grain: 'customer', key: 'id', columns: ['id', 'name', 'region', 'created_at', 'is_test'] },
        { name: 'orders', grain: 'order', key: 'id', columns: ['id', 'customer_id', 'status', 'channel', 'is_test', 'created_at', 'paid_at', 'total', 'tax', 'shipping'] },
        { name: 'order_lines', grain: 'item on an order', key: 'id', columns: ['id', 'order_id', 'product_id', 'quantity', 'unit_price', 'discount', 'net_amount', 'refunded_at'] },
        { name: 'products', grain: 'product', key: 'id', columns: ['id', 'name', 'category', 'roast'] },
      ],
      relationships: [
        { one: 'customers.id', many: 'orders.customer_id' },
        { one: 'orders.id', many: 'order_lines.order_id' },
        { one: 'products.id', many: 'order_lines.product_id' },
      ],
    };
  }

  // Three answers an AI assistant might give. Written the way they tend to
  // come back: confident comments, tidy formatting.
  var ANSWERS = [
    {
      id: 'refunds',
      title: 'Revenue in Q3 2026',
      blurb: 'Confident SQL that counts refunds and test orders.',
      tone: 'bad',
      question: 'What was revenue in Q3 2026?',
      sql: [
        '-- Revenue for Q3 2026 (Jul 1 - Sep 30), New York time',
        'SELECT',
        '  SUM(ol.net_amount) AS revenue',
        'FROM order_lines AS ol',
        'JOIN orders AS o',
        '  ON o.id = ol.order_id',
        "WHERE o.status = 'paid'",
        "  AND o.paid_at AT TIME ZONE 'America/New_York' >= '2026-07-01'",
        "  AND o.paid_at AT TIME ZONE 'America/New_York' <  '2026-10-01';",
      ].join('\n'),
    },
    {
      id: 'fanout',
      title: 'Average order value by channel',
      blurb: 'A join that counts every order once per item.',
      tone: 'bad',
      question: 'What was average order value by channel in September 2026?',
      sql: [
        '/* Average order value by sales channel, September 2026.',
        '   Joined to order_lines so refunded items can be left out. */',
        'SELECT',
        '  o.channel,',
        '  SUM(ol.net_amount) / COUNT(o.id) AS avg_order_value',
        'FROM orders o',
        'JOIN order_lines ol ON ol.order_id = o.id',
        "WHERE o.status = 'paid'",
        '  AND NOT o.is_test',
        '  AND ol.refunded_at IS NULL',
        "  AND (o.paid_at AT TIME ZONE 'America/New_York') >= DATE '2026-09-01'",
        "  AND (o.paid_at AT TIME ZONE 'America/New_York') <  DATE '2026-10-01'",
        'GROUP BY o.channel',
        'ORDER BY avg_order_value DESC;',
      ].join('\n'),
    },
    {
      id: 'correct',
      title: 'Active customers by month',
      blurb: 'Right - and checked through a CTE.',
      tone: 'good',
      question: 'How many active customers did we have each month in Q3 2026?',
      sql: [
        'WITH paid AS (',
        '  SELECT',
        '    o.customer_id,',
        "    DATE_TRUNC('month', o.paid_at AT TIME ZONE 'America/New_York') AS month",
        '  FROM orders o',
        "  WHERE o.status = 'paid'",
        '    AND o.is_test IS FALSE',
        "    AND o.paid_at AT TIME ZONE 'America/New_York' >= '2026-07-01'",
        "    AND o.paid_at AT TIME ZONE 'America/New_York' <  '2026-10-01'",
        ')',
        'SELECT month, COUNT(DISTINCT customer_id) AS active_customers',
        'FROM paid',
        'GROUP BY month',
        'ORDER BY month;',
      ].join('\n'),
    },
  ];

  return { canon: canon, answers: function () { return ANSWERS.map(function (a) { return Object.assign({}, a); }); }, NAME: 'Fernhill Coffee Co.' };
}));
