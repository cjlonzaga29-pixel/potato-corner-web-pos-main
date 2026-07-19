import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// All prices are VAT-inclusive (Architecture doc VAT formula extracts VAT
// from the tendered total, it is never added on top at the POS). Every
// price below is a seed default only — editable afterward via the Admin
// product/variant screens, never hardcoded elsewhere.

const FLAVORS = [
  { name: 'Cheese', isPremium: false, addOnPrice: 0 },
  { name: 'BBQ', isPremium: false, addOnPrice: 0 },
  { name: 'Sour Cream', isPremium: false, addOnPrice: 0 },
  { name: 'White Cheddar', isPremium: false, addOnPrice: 0 },
  { name: 'Sour Cheese', isPremium: false, addOnPrice: 0 },
  { name: 'Chili BBQ', isPremium: false, addOnPrice: 0 },
  { name: 'Chili Cheese', isPremium: false, addOnPrice: 0 },
  { name: 'Sweet Corn', isPremium: true, addOnPrice: 10 },
] as const;

type VariantSeed = {
  sizeLabel: string;
  basePrice: number;
  maxFlavors: number;
  withFlavors: boolean;
};

type ProductSeed = {
  name: string;
  category: string;
  variants: VariantSeed[];
};

// Flavored Fries: maxFlavors is 1 by default, 2 for Mega/Giga, 3 for Tera —
// per the brief's explicit sizing rule. Loopys, Crunchy Chicken Pops, Mix &
// Max, and Drinks are not flavor-selectable in this phase (Mix & Max has no
// separate flavor choice per approved default; the others simply weren't
// specified as flavored in the source menu image).
const PRODUCTS: ProductSeed[] = [
  {
    name: 'Flavored Fries',
    category: 'Fries',
    variants: [
      { sizeLabel: 'Regular', basePrice: 42, maxFlavors: 1, withFlavors: true },
      { sizeLabel: 'Large', basePrice: 69, maxFlavors: 1, withFlavors: true },
      { sizeLabel: 'Jumbo', basePrice: 99, maxFlavors: 1, withFlavors: true },
      { sizeLabel: 'Mega', basePrice: 129, maxFlavors: 2, withFlavors: true },
      { sizeLabel: 'Giga', basePrice: 200, maxFlavors: 2, withFlavors: true },
      { sizeLabel: 'Tera', basePrice: 230, maxFlavors: 3, withFlavors: true },
    ],
  },
  {
    name: 'Loopys',
    category: 'Fries',
    variants: [
      { sizeLabel: 'Large', basePrice: 75, maxFlavors: 1, withFlavors: false },
      { sizeLabel: 'Mega', basePrice: 135, maxFlavors: 1, withFlavors: false },
    ],
  },
  {
    name: 'Crunchy Chicken Pops',
    category: 'Chicken',
    variants: [
      { sizeLabel: 'Regular', basePrice: 79, maxFlavors: 1, withFlavors: false },
      { sizeLabel: 'Large', basePrice: 99, maxFlavors: 1, withFlavors: false },
      { sizeLabel: 'Mega', basePrice: 199, maxFlavors: 1, withFlavors: false },
    ],
  },
  {
    name: 'Mix & Max',
    category: 'Combos',
    variants: [
      { sizeLabel: 'Large Mix', basePrice: 99, maxFlavors: 0, withFlavors: false },
      { sizeLabel: 'Mega Mix', basePrice: 149, maxFlavors: 0, withFlavors: false },
      { sizeLabel: 'Tera Mix', basePrice: 259, maxFlavors: 0, withFlavors: false },
    ],
  },
  {
    name: 'Drinks',
    category: 'Drinks',
    variants: [
      { sizeLabel: 'Water', basePrice: 35, maxFlavors: 0, withFlavors: false },
      { sizeLabel: 'Soda', basePrice: 45, maxFlavors: 0, withFlavors: false },
    ],
  },
];

async function upsertFlavor(seed: (typeof FLAVORS)[number]) {
  const existing = await prisma.flavor.findFirst({ where: { name: seed.name } });
  if (existing) {
    return prisma.flavor.update({
      where: { id: existing.id },
      data: { isPremium: seed.isPremium, addOnPrice: seed.addOnPrice },
    });
  }
  return prisma.flavor.create({ data: seed });
}

async function upsertProduct(name: string, category: string) {
  const existing = await prisma.product.findFirst({ where: { name } });
  if (existing) {
    return prisma.product.update({ where: { id: existing.id }, data: { category, status: 'active' } });
  }
  return prisma.product.create({ data: { name, category, status: 'active' } });
}

async function upsertVariant(productId: string, seed: VariantSeed) {
  const existing = await prisma.productVariant.findFirst({
    where: { productId, sizeLabel: seed.sizeLabel },
  });
  const data = {
    name: seed.sizeLabel,
    sizeLabel: seed.sizeLabel,
    basePrice: seed.basePrice,
    maxFlavors: seed.maxFlavors,
  };
  if (existing) {
    return prisma.productVariant.update({ where: { id: existing.id }, data });
  }
  return prisma.productVariant.create({ data: { productId, ...data } });
}

async function main() {
  const flavors = new Map<string, string>();
  for (const seed of FLAVORS) {
    const flavor = await upsertFlavor(seed);
    flavors.set(seed.name, flavor.id);
  }

  for (const product of PRODUCTS) {
    const { id: productId } = await upsertProduct(product.name, product.category);

    for (const variantSeed of product.variants) {
      const variant = await upsertVariant(productId, variantSeed);

      if (variantSeed.withFlavors) {
        for (const flavorSeed of FLAVORS) {
          const flavorId = flavors.get(flavorSeed.name)!;
          await prisma.productVariantFlavor.upsert({
            where: { productVariantId_flavorId: { productVariantId: variant.id, flavorId } },
            update: { pricePremium: flavorSeed.addOnPrice },
            create: { productVariantId: variant.id, flavorId, pricePremium: flavorSeed.addOnPrice },
          });
        }
      }
    }
  }

  console.log(`Seeded ${FLAVORS.length} flavors and ${PRODUCTS.length} products.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
