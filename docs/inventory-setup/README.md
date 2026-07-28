# Master BOM Template — Potato Corner Catalog

These CSV templates are for entering real ingredient, packaging, and serving
quantities before any inventory/BOM database records are created. No data
here has been imported, and no migration has been applied against these
templates.

## Files

- `ingredients-template.csv` — master inventory item list (raw materials,
  packaging, finished goods, seasonings)
- `product-bom-template.csv` — base/packaging mappings per product variant
- `flavor-bom-template.csv` — seasoning mappings per Flavored Fries variant x flavor
- `mix-max-snack-options-template.csv` — candidate snack options per Mix & Max slot
- `opening-stock-template.csv` — opening stock counts per inventory item

## How to fill these in

1. Fill in one copy per branch. Duplicate the CSVs per branch, or fill the
   `branch_name` column consistently for each branch's rows.
2. Do not change product, variant, or flavor names without matching the
   production catalog. Names in these templates must match existing
   product/variant/flavor records exactly.
3. Quantities must represent consumption per one product sale (i.e. how much
   of the ingredient/packaging is consumed for a single unit sold).
4. Use consistent units:
   - `g` for powders/raw ingredients
   - `ml` for liquids
   - `pc` for packaging and finished goods
5. Mix & Max parent rows (`product-bom-template.csv`) contain packaging only.
   No snack ingredients are attached to the parent Mix & Max product row.
6. Mix & Max snack ingredients come from whichever snack variant is selected
   for each slot in `mix-max-snack-options-template.csv` — the snack variant's
   own BOM (fries/loopys/chicken pops base + packaging) applies, not a
   separate ingredient list.
7. Opening stock must be entered only after BOM mappings are reviewed and
   confirmed correct.
8. Tissue and Fork are optional inventory-tracked items — confirm whether the
   business wants to track them before filling in quantities/costs.
9. Do not import anything until the pending migration is reviewed and applied
   safely.

**The template structure is normalized, but validation will continue to fail
until the user supplies real branch, quantity, unit, cost, stock, and
snack-variant values.**

## User Decisions Required

The following values were intentionally left blank and require input from
someone with real recipe/ops knowledge before any BOM records are created:

- Serving quantity for every size (Regular/Large/Jumbo/Mega/Giga/Tera fries;
  Large/Mega Loopys; Regular/Large/Mega Chicken Pops)
- Oil allocation per fries size
- Seasoning quantity per flavor and size (all 48 rows in
  `flavor-bom-template.csv`)
- Packaging used per variant — confirm the container/box names in
  `ingredients-template.csv` match what's actually stocked
- Exact snack variant linked to each Mix & Max slot (all rows in
  `mix-max-snack-options-template.csv` — `allowed_snack_variant` is blank)
- Whether Tissue and Fork should be tracked as inventory at all
- Opening stock quantity, unit cost, branch, and effective date for every
  item in `opening-stock-template.csv`
- Costs (`cost_per_unit`) and reorder levels for every item in
  `ingredients-template.csv`
