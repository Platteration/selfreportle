// @ts-check
// What the website sells through server/kit (sign in with Google, Stripe Checkout and its
// webhook): one "Support this app" payment and nothing else. It unlocks nothing: the checker and
// the extension work the same for everyone. A paid checkout grants the entitlement `supporter`,
// which `GET api/me` then reports and the page shows as "Owned" (web/account.js). Its Stripe
// Price id is STRIPE_PRICE_SUPPORTER; without that variable nothing is sold.
//
// Only the website (web/) talks to this. The extension never calls it, and its manifest names
// no host for it (test/website.test.js).
//
// The kit checks this at start-up and throws on a malformed one (an unknown field included), and
// test/api.test.mjs holds it to what web/account.js asks for.

export default {
  app: 'selfreportle',
  name: 'Selfreportle',
  products: [
    {
      id: 'supporter',
      name: 'Support this app',
      description: 'A one-time payment towards Selfreportle. It unlocks nothing: the checker and the extension stay the same for everyone.',
      mode: 'payment',
      grants: 'supporter',
    },
  ],
};
