// Landed-cost pricing: what it really costs to get a product from a China
// supplier to a US customer's door, and the retail price that keeps your margin.
//
// NOTE: The US ended the $800 "de minimis" duty-free exemption for China-origin
// goods in 2025, so every parcel now owes duty. Tariff rates on Chinese goods
// change often — set DUTY_RATE from your customs broker / carrier, don't guess.

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

function config() {
  return {
    dutyRate: num(process.env.DUTY_RATE, 0.3), // fraction of product value
    targetMargin: num(process.env.TARGET_MARGIN, 0.3), // fraction of retail price
    paymentPctFee: num(process.env.PAYMENT_PCT_FEE, 0.0349),
    paymentFixedFee: num(process.env.PAYMENT_FIXED_FEE, 0.49),
  };
}

function roundTo99(x) {
  return Math.max(0.99, Math.ceil(x) - 0.01);
}

/**
 * @param {object} p  { supplierCost, shippingCost, dutyRate?, targetMargin? }  all USD
 */
function quote(p) {
  const c = config();
  const supplierCost = num(p.supplierCost, 0);
  const shippingCost = num(p.shippingCost, 0);
  const dutyRate = num(p.dutyRate, c.dutyRate);
  const margin = num(p.targetMargin, c.targetMargin);

  const duty = supplierCost * dutyRate; // US duty is assessed on product value
  const landedCost = supplierCost + shippingCost + duty;

  // price = (landed + fixedFee) / (1 - margin - pctFee)
  const denom = 1 - margin - c.paymentPctFee;
  if (denom <= 0) throw new Error('Margin + payment fee must be below 100%');
  const price = roundTo99((landedCost + c.paymentFixedFee) / denom);

  const fees = price * c.paymentPctFee + c.paymentFixedFee;
  const profit = price - landedCost - fees;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    supplierCost: r2(supplierCost),
    shippingCost: r2(shippingCost),
    dutyRate,
    duty: r2(duty),
    landedCost: r2(landedCost),
    paymentFees: r2(fees),
    price: r2(price),
    profit: r2(profit),
    margin: r2(profit / price),
  };
}

module.exports = { quote, config };
