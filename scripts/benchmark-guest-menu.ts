import { guestMenu, invalidateGuestMenu } from '../main/lib/guest-menu-cache';

async function main() {
  invalidateGuestMenu();
  let loads = 0;
  const start = performance.now();
  const menus = await Promise.all(
    Array.from({ length: 20 }, () =>
      guestMenu(async () => {
        loads++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { products: ['coffee'] };
      }),
    ),
  );
  if (menus.some((menu) => menu?.products[0] !== 'coffee')) throw new Error('Missing menu');
  console.log(
    JSON.stringify({
      kind: 'controlled concurrent cache misses',
      requests: 20,
      catalogLoads: loads,
      elapsedMs: Math.round(performance.now() - start),
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
