/* Shelf Life - the rules, in one file, run three times: by the page (a
 * kitchen on this phone, the example kitchen, and the board of a shared
 * one), by the server (which checks and stores every change to a shared
 * kitchen), and by the tests. UMD: window.ShelfCore in the page, require()
 * in node.
 *
 * Nothing here touches a store, the network or the clock on its own: every
 * function is handed `today` (a 'YYYY-MM-DD' in the kitchen's own time zone)
 * or `now`, so two phones looking at one kitchen draw the same board.
 *
 * What is in it:
 *   - the CATALOGUE: ~150 everyday foods, each with an emoji, where it
 *     usually lives, a typical shelf life sealed and opened, how it freezes,
 *     a typical price and, for the ones people bin most, a buying tip;
 *   - cleanItem: the ONE function every item goes through - typed, tapped
 *     from the weekly-shop grid, read from a photo by a model, or brought
 *     online from a phone;
 *   - bands ("Past its date", "Today", "Tomorrow", "This week", "Later") and
 *     the one-line headline;
 *   - the actions - ate it, binned it, opened it, froze it, thawed it, +days,
 *     edit, cook - each returning a PATCH of the keys it changes
 *     ({set: {'items.<id>': item}, del: ['items.<id>']}), which the page
 *     applies to its own copy and the server writes as single keys in a
 *     transaction, so two phones never lose each other's change;
 *   - RECIPES: ~40 simple ones ranked by how much of what is going off they
 *     use and how little they need;
 *   - stats: eaten vs binned, an estimate of money rescued, the most-binned
 *     foods with a tip, and the streak of days with nothing binned;
 *   - the shopping nudge: "Don't buy" and "Running out?".
 *
 * Shelf lives are GUIDANCE, typical for the food in a home fridge - never a
 * safety claim. The page says so: use your eyes and nose; when in doubt,
 * throw it out.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShelfCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const LIMITS = {
    items: 400,
    history: 600,       // events kept...
    historyDays: 120,   // ...and for no longer than this
    kitchenName: 40,
    itemName: 40,
    memberName: 20,
    members: 12,
    qty: 99,
    snapItems: 40,      // a photo's proposal, at most
    ideaItems: 80,      // what the chef's idea is told about
    steps: 8,
    extras: 8,
    addAtOnce: 60,
  };
  const PLACES = [
    { id: 'fridge', label: 'Fridge', emoji: '🧊' },
    { id: 'freezer', label: 'Freezer', emoji: '❄️' },
    { id: 'pantry', label: 'Pantry', emoji: '🥫' },
  ];
  const PLACE_IDS = PLACES.map((p) => p.id);
  const BANDS = [
    { id: 'past', label: 'Past its date', short: 'Past' },
    { id: 'today', label: 'Today', short: 'Today' },
    { id: 'tomorrow', label: 'Tomorrow', short: 'Tomorrow' },
    { id: 'week', label: 'This week', short: 'This week' },
    { id: 'later', label: 'Later', short: 'Later' },
  ];
  const EMOJI = ['🦊', '🐻', '🦋', '🐢', '🐙', '🦉', '🐝', '🌵', '🦄', '🐸', '🐧', '🦁', '🐳', '🌻', '🍋', '🍓', '🌈', '⚡', '🎸', '🚲', '🎯', '🧢', '🦖', '🐼'];

  // How long a food keeps once frozen, by group (days; 0 = it does not
  // freeze well), and how soon to use it once thawed.
  const GROUP = {
    dairy: { freeze: 60, thaw: 2, price: 2 },
    cheese: { freeze: 120, thaw: 5, price: 3.5 },
    eggs: { freeze: 0, thaw: 2, price: 3 },
    meat: { freeze: 120, thaw: 1, price: 6 },
    fish: { freeze: 90, thaw: 1, price: 7 },
    veg: { freeze: 240, thaw: 2, price: 1.5 },
    salad: { freeze: 0, thaw: 1, price: 2 },
    herb: { freeze: 120, thaw: 1, price: 1.5 },
    fruit: { freeze: 180, thaw: 2, price: 2.5 },
    bakery: { freeze: 90, thaw: 3, price: 2.5 },
    cooked: { freeze: 90, thaw: 1, price: 4 },
    deli: { freeze: 60, thaw: 2, price: 3 },
    jar: { freeze: 0, thaw: 3, price: 2.5 },
    tin: { freeze: 0, thaw: 2, price: 1.2 },
    dry: { freeze: 0, thaw: 2, price: 2 },
    frozen: { freeze: 365, thaw: 2, price: 3 },
    treat: { freeze: 90, thaw: 2, price: 3 },
    drink: { freeze: 0, thaw: 2, price: 3 },
  };

  // [id, name, emoji, usual place, days sealed, days once opened (0 = no
  //  change), typical price (USD, one pack), group, {a: aliases, tip, op:
  //  where it goes once opened, f: freezer days overriding the group}]
  const ROWS = [
    // dairy and eggs
    ['milk', 'Milk', '🥛', 'fridge', 7, 5, 1.5, 'dairy', { a: 'whole milk|semi skimmed|skimmed milk|skim milk|2% milk', tip: 'buy the smaller bottle, or freeze half', f: 90 }],
    ['oatmilk', 'Oat milk', '🥛', 'pantry', 180, 7, 2.5, 'dairy', { a: 'plant milk|almond milk|soy milk|soya milk', op: 'fridge', f: 0 }],
    ['yoghurt', 'Yoghurt', '🥣', 'fridge', 14, 5, 1.2, 'dairy', { a: 'yogurt|yoghurts|yogurts|fruit yoghurt' }],
    ['greekyog', 'Greek yoghurt', '🥣', 'fridge', 14, 5, 3, 'dairy', { a: 'greek yogurt|skyr|natural yoghurt' }],
    ['butter', 'Butter', '🧈', 'fridge', 60, 30, 3, 'dairy', { a: 'spread|margarine', f: 180 }],
    ['cream', 'Cream', '🥛', 'fridge', 10, 4, 2, 'dairy', { a: 'double cream|heavy cream|single cream|whipping cream' }],
    ['sourcream', 'Sour cream', '🥣', 'fridge', 14, 7, 2, 'dairy', { a: 'creme fraiche|crème fraîche', f: 0 }],
    ['custard', 'Custard', '🍮', 'fridge', 10, 3, 2, 'dairy', { a: 'pudding|dessert pots|rice pudding', f: 0 }],
    ['creamcheese', 'Cream cheese', '🧀', 'fridge', 21, 7, 2.5, 'cheese', { a: 'philadelphia|soft cheese|mascarpone', f: 0 }],
    ['cheddar', 'Cheddar', '🧀', 'fridge', 42, 28, 4, 'cheese', { a: 'cheese|hard cheese|gouda|grated cheese|red leicester', tip: 'grate and freeze what you won’t get to' }],
    ['parmesan', 'Parmesan', '🧀', 'fridge', 60, 30, 5, 'cheese', { a: 'parmigiano|pecorino|grana padano' }],
    ['mozzarella', 'Mozzarella', '🧀', 'fridge', 14, 3, 2.5, 'cheese', { a: 'burrata' }],
    ['feta', 'Feta', '🧀', 'fridge', 30, 5, 3, 'cheese', { a: 'goats cheese|goat cheese', tip: 'buy the smaller block' }],
    ['brie', 'Brie', '🧀', 'fridge', 14, 5, 4, 'cheese', { a: 'camembert' }],
    ['halloumi', 'Halloumi', '🧀', 'fridge', 30, 3, 3.5, 'cheese', {}],
    ['cottage', 'Cottage cheese', '🥣', 'fridge', 10, 5, 2, 'cheese', { a: 'ricotta', f: 0 }],
    ['eggs', 'Eggs', '🥚', 'fridge', 28, 0, 3, 'eggs', { a: 'egg|dozen eggs|free range eggs|half dozen eggs' }],
    ['juice', 'Orange juice', '🧃', 'fridge', 10, 7, 2.5, 'drink', { a: 'juice|oj|apple juice|fresh juice', f: 90 }],
    // meat
    ['chicken', 'Raw chicken', '🍗', 'fridge', 2, 0, 6, 'meat', { a: 'chicken|chicken breast|chicken breasts|chicken thighs|chicken thigh|drumsticks|chicken wings|whole chicken', tip: 'freeze it the day you buy it if plans change', f: 270 }],
    ['roastchicken', 'Cooked chicken', '🍗', 'fridge', 4, 0, 7, 'cooked', { a: 'roast chicken|rotisserie chicken|leftover chicken|half a chicken|half a roast chicken' }],
    ['mince', 'Beef mince', '🥩', 'fridge', 2, 0, 5, 'meat', { a: 'mince|ground beef|minced beef|turkey mince|ground turkey|pork mince', f: 120 }],
    ['burgers', 'Burgers', '🍔', 'fridge', 3, 0, 5, 'meat', { a: 'burger patties|beef burgers|burger' }],
    ['meatballs', 'Meatballs', '🍖', 'fridge', 3, 0, 4, 'meat', {}],
    ['steak', 'Steak', '🥩', 'fridge', 3, 0, 9, 'meat', { a: 'beef|sirloin|ribeye', f: 180 }],
    ['pork', 'Pork chops', '🥩', 'fridge', 3, 0, 5, 'meat', { a: 'pork|pork loin|pork chop|pork belly', f: 180 }],
    ['lamb', 'Lamb', '🥩', 'fridge', 3, 0, 8, 'meat', { a: 'lamb chops|lamb mince', f: 180 }],
    ['sausages', 'Sausages', '🌭', 'fridge', 4, 2, 4, 'meat', { a: 'sausage|bratwurst|hot dogs|frankfurters', f: 60 }],
    ['bacon', 'Bacon', '🥓', 'fridge', 7, 5, 4, 'meat', { a: 'pancetta|lardons|streaky bacon', f: 30 }],
    ['ham', 'Sliced ham', '🍖', 'fridge', 7, 3, 3.5, 'deli', { a: 'ham|deli ham|cooked ham|prosciutto' }],
    ['turkey', 'Sliced turkey', '🍖', 'fridge', 7, 4, 4, 'deli', { a: 'turkey|deli turkey|turkey slices|chicken slices' }],
    ['salami', 'Salami', '🍖', 'fridge', 30, 5, 4, 'deli', { a: 'pepperoni|cured meats' }],
    ['chorizo', 'Chorizo', '🌭', 'fridge', 30, 7, 3.5, 'deli', {}],
    // fish and other protein
    ['salmon', 'Salmon', '🐟', 'fridge', 2, 0, 8, 'fish', { a: 'salmon fillets|salmon fillet|trout' }],
    ['whitefish', 'White fish', '🐟', 'fridge', 2, 0, 7, 'fish', { a: 'cod|haddock|pollock|hake|tilapia|fish|sea bass' }],
    ['prawns', 'Prawns', '🦐', 'fridge', 2, 0, 7, 'fish', { a: 'shrimp|king prawns' }],
    ['smokedsalmon', 'Smoked salmon', '🐟', 'fridge', 10, 2, 6, 'fish', { a: 'lox', f: 60 }],
    ['mackerel', 'Smoked mackerel', '🐟', 'fridge', 14, 3, 3, 'fish', { a: 'mackerel|kippers' }],
    ['tuna', 'Tinned tuna', '🥫', 'pantry', 730, 2, 1.5, 'tin', { a: 'tuna|canned tuna|tuna can', op: 'fridge' }],
    ['tofu', 'Tofu', '🍱', 'fridge', 30, 4, 2.5, 'deli', { a: 'tempeh|silken tofu', f: 90 }],
    ['falafel', 'Falafel', '🧆', 'fridge', 7, 3, 3, 'deli', {}],
    // leafy and salad
    ['spinach', 'Spinach', '🥬', 'fridge', 5, 0, 2.5, 'salad', { a: 'baby spinach', tip: 'buy the small bag, or freeze some for smoothies', f: 180 }],
    ['lettuce', 'Lettuce', '🥬', 'fridge', 7, 0, 1.5, 'salad', { a: 'iceberg|romaine|little gem|cos lettuce', tip: 'buy a whole head - it outlasts a bag' }],
    ['saladbag', 'Salad leaves', '🥗', 'fridge', 4, 2, 2, 'salad', { a: 'salad|bagged salad|mixed leaves|salad bag|lambs lettuce', tip: 'buy the small bag, or a whole lettuce' }],
    ['rocket', 'Rocket', '🥬', 'fridge', 4, 2, 2, 'salad', { a: 'arugula|watercress', tip: 'buy the small bag' }],
    ['kale', 'Kale', '🥬', 'fridge', 7, 0, 2, 'veg', { a: 'cavolo nero|chard|swiss chard|spring greens' }],
    ['pakchoi', 'Pak choi', '🥬', 'fridge', 4, 0, 1.5, 'veg', { a: 'bok choy|bok choi' }],
    ['cabbage', 'Cabbage', '🥬', 'fridge', 21, 7, 1.5, 'veg', { a: 'red cabbage|savoy cabbage|white cabbage' }],
    ['coleslaw', 'Coleslaw', '🥗', 'fridge', 7, 3, 2, 'deli', { f: 0 }],
    ['sprouts', 'Brussels sprouts', '🥬', 'fridge', 7, 0, 2, 'veg', { a: 'brussel sprouts|sprouts' }],
    // vegetables
    ['broccoli', 'Broccoli', '🥦', 'fridge', 7, 0, 1.5, 'veg', { a: 'tenderstem|broccolini|purple sprouting' }],
    ['cauliflower', 'Cauliflower', '🥦', 'fridge', 10, 0, 2, 'veg', {}],
    ['carrots', 'Carrots', '🥕', 'fridge', 21, 0, 1, 'veg', { a: 'carrot|baby carrots' }],
    ['parsnips', 'Parsnips', '🥕', 'fridge', 14, 0, 1.5, 'veg', { a: 'parsnip|swede|turnip' }],
    ['peppers', 'Peppers', '🫑', 'fridge', 10, 3, 1.2, 'veg', { a: 'pepper|bell pepper|bell peppers|capsicum|red pepper|green pepper' }],
    ['cucumber', 'Cucumber', '🥒', 'fridge', 7, 3, 1, 'veg', { f: 0 }],
    ['courgette', 'Courgette', '🥒', 'fridge', 7, 0, 1, 'veg', { a: 'zucchini|courgettes|zucchinis' }],
    ['tomatoes', 'Tomatoes', '🍅', 'pantry', 7, 2, 2, 'veg', { a: 'tomato|cherry tomatoes|vine tomatoes|plum tomatoes fresh' }],
    ['mushrooms', 'Mushrooms', '🍄', 'fridge', 5, 0, 2, 'veg', { a: 'mushroom|chestnut mushrooms|button mushrooms|portobello', tip: 'buy them loose - just what you need' }],
    ['greenbeans', 'Green beans', '🌱', 'fridge', 5, 0, 2, 'veg', { a: 'fine beans|runner beans|mangetout|sugar snap peas|snap peas|edamame' }],
    ['asparagus', 'Asparagus', '🌱', 'fridge', 3, 0, 3, 'veg', {}],
    ['celery', 'Celery', '🥬', 'fridge', 14, 0, 1, 'veg', {}],
    ['leeks', 'Leeks', '🥬', 'fridge', 10, 0, 1.5, 'veg', { a: 'leek' }],
    ['springonion', 'Spring onions', '🧅', 'fridge', 7, 0, 0.8, 'veg', { a: 'scallions|green onions|spring onion' }],
    ['onions', 'Onions', '🧅', 'pantry', 30, 5, 1, 'veg', { a: 'onion|red onion|red onions|shallots|shallot', op: 'fridge' }],
    ['garlic', 'Garlic', '🧄', 'pantry', 60, 10, 0.6, 'veg', {}],
    ['ginger', 'Ginger', '🌱', 'fridge', 21, 10, 0.8, 'veg', { a: 'root ginger|fresh ginger|lemongrass' }],
    ['chilli', 'Chillies', '🌶️', 'fridge', 10, 0, 0.8, 'veg', { a: 'chilli|chili|chilies|chillis|jalapeno|jalapeño' }],
    ['potatoes', 'Potatoes', '🥔', 'pantry', 30, 0, 2, 'veg', { a: 'potato|new potatoes|baby potatoes|spuds', f: 0 }],
    ['sweetpot', 'Sweet potatoes', '🍠', 'pantry', 21, 0, 1.5, 'veg', { a: 'sweet potato|yams|yam' }],
    ['butternut', 'Butternut squash', '🎃', 'pantry', 30, 5, 2, 'veg', { a: 'squash|pumpkin|butternut', op: 'fridge' }],
    ['aubergine', 'Aubergine', '🍆', 'fridge', 5, 0, 1.2, 'veg', { a: 'eggplant|aubergines' }],
    ['beetroot', 'Beetroot', '🍠', 'fridge', 14, 5, 1.5, 'veg', { a: 'beets|beet|radishes|radish' }],
    ['corn', 'Corn on the cob', '🌽', 'fridge', 3, 0, 1, 'veg', { a: 'corn|sweetcorn cob|corn cobs' }],
    ['beansprouts', 'Beansprouts', '🌱', 'fridge', 2, 0, 1, 'veg', { a: 'bean sprouts', f: 0 }],
    ['herbs', 'Fresh herbs', '🌿', 'fridge', 5, 0, 1.5, 'herb', { a: 'basil|coriander|cilantro|parsley|mint|dill|chives|rosemary|thyme', tip: 'freeze the rest chopped, in oil, in an ice-cube tray' }],
    // fruit
    ['avocado', 'Avocado', '🥑', 'pantry', 4, 1, 1.2, 'fruit', { a: 'avocados|avo|avos', tip: 'buy one ripe and one hard', op: 'fridge' }],
    ['lemon', 'Lemons', '🍋', 'pantry', 14, 4, 0.5, 'fruit', { a: 'lemon|lime|limes', op: 'fridge' }],
    ['bananas', 'Bananas', '🍌', 'pantry', 5, 0, 1.2, 'fruit', { a: 'banana', tip: 'buy them greener - and freeze the brown ones for banana bread', f: 90 }],
    ['apples', 'Apples', '🍎', 'fridge', 30, 0, 2.5, 'fruit', { a: 'apple' }],
    ['pears', 'Pears', '🍐', 'pantry', 5, 0, 2, 'fruit', { a: 'pear' }],
    ['oranges', 'Oranges', '🍊', 'pantry', 14, 0, 2.5, 'fruit', { a: 'orange|satsumas|clementines|mandarins|easy peelers|tangerines' }],
    ['berries', 'Strawberries', '🍓', 'fridge', 3, 0, 3, 'fruit', { a: 'strawberry|raspberries|raspberry|berries|mixed berries', tip: 'buy one punnet at a time - or freeze them for smoothies' }],
    ['blueberries', 'Blueberries', '🫐', 'fridge', 7, 0, 3, 'fruit', { a: 'blueberry|blackberries|blackberry' }],
    ['grapes', 'Grapes', '🍇', 'fridge', 7, 0, 3, 'fruit', { a: 'grape' }],
    ['melon', 'Melon', '🍈', 'pantry', 7, 3, 3, 'fruit', { a: 'honeydew|cantaloupe|watermelon', op: 'fridge' }],
    ['pineapple', 'Pineapple', '🍍', 'pantry', 5, 3, 2.5, 'fruit', { op: 'fridge' }],
    ['mango', 'Mango', '🥭', 'pantry', 5, 2, 1.5, 'fruit', { a: 'mangoes|papaya', op: 'fridge' }],
    ['kiwi', 'Kiwis', '🥝', 'pantry', 7, 0, 1.5, 'fruit', { a: 'kiwi fruit|kiwi' }],
    ['peaches', 'Peaches', '🍑', 'pantry', 4, 0, 2.5, 'fruit', { a: 'peach|nectarines|nectarine|plums|plum|apricots' }],
    ['cherries', 'Cherries', '🍒', 'fridge', 5, 0, 4, 'fruit', { a: 'cherry' }],
    // bakery
    ['bread', 'Bread', '🍞', 'pantry', 5, 0, 2.5, 'bakery', { a: 'loaf|sliced bread|sourdough|wholemeal bread|white bread|brown bread', tip: 'freeze half the loaf and toast it from frozen' }],
    ['wraps', 'Tortilla wraps', '🌯', 'pantry', 14, 7, 2, 'bakery', { a: 'wraps|tortillas|tortilla|wrap' }],
    ['bagels', 'Bagels', '🥯', 'pantry', 5, 0, 2.5, 'bakery', { a: 'bagel|english muffins|crumpets' }],
    ['croissants', 'Croissants', '🥐', 'pantry', 2, 0, 3, 'bakery', { a: 'croissant|pastries|pain au chocolat' }],
    ['rolls', 'Bread rolls', '🥖', 'pantry', 3, 0, 2, 'bakery', { a: 'rolls|baguette|buns|burger buns|hot dog buns|bread roll' }],
    ['pitta', 'Pitta bread', '🫓', 'pantry', 5, 3, 1.5, 'bakery', { a: 'pitta|pita|naan|flatbreads|flatbread|naan bread' }],
    ['cake', 'Cake', '🍰', 'pantry', 4, 3, 5, 'treat', { a: 'brownies|muffins|doughnuts|donuts|cupcakes' }],
    // cooked and fresh-chilled
    ['leftovers', 'Leftovers', '🍲', 'fridge', 4, 0, 4, 'cooked', { a: 'leftover|left overs|left-overs' }],
    ['cookedrice', 'Cooked rice', '🍚', 'fridge', 1, 0, 1, 'cooked', { a: 'leftover rice|rice cooked' }],
    ['cookedpasta', 'Cooked pasta', '🍝', 'fridge', 3, 0, 1.5, 'cooked', { a: 'leftover pasta' }],
    ['soup', 'Soup', '🥣', 'fridge', 4, 2, 3, 'cooked', { a: 'homemade soup|fresh soup' }],
    ['pizzaleft', 'Leftover pizza', '🍕', 'fridge', 3, 0, 4, 'cooked', { a: 'pizza slices|cold pizza' }],
    ['takeaway', 'Takeaway', '🥡', 'fridge', 3, 0, 6, 'cooked', { a: 'takeout|chinese|indian|thai' }],
    ['quiche', 'Quiche', '🥧', 'fridge', 5, 3, 4, 'deli', { a: 'pie|pies|sausage rolls|pasties|pork pie' }],
    ['freshpasta', 'Fresh pasta', '🍝', 'fridge', 14, 2, 3, 'deli', { a: 'ravioli|tortellini' }],
    ['gnocchi', 'Gnocchi', '🥔', 'pantry', 60, 3, 2, 'deli', { op: 'fridge' }],
    ['pastry', 'Ready-rolled pastry', '🥧', 'fridge', 14, 2, 2, 'deli', { a: 'puff pastry|shortcrust pastry|filo|pastry' }],
    // dips, jars and tins
    ['hummus', 'Hummus', '🥙', 'fridge', 10, 5, 2, 'deli', { a: 'houmous|houmus|tzatziki|baba ganoush' }],
    ['guacamole', 'Guacamole', '🥑', 'fridge', 5, 2, 3, 'deli', { a: 'guac', f: 0 }],
    ['pesto', 'Pesto', '🌿', 'pantry', 365, 5, 2.5, 'jar', { op: 'fridge' }],
    ['salsa', 'Salsa', '🌶️', 'pantry', 365, 7, 2.5, 'jar', { a: 'tomato salsa|dip', op: 'fridge' }],
    ['passata', 'Passata', '🍅', 'pantry', 365, 5, 1.2, 'jar', { a: 'tomato sauce|tomato puree|tomato paste', op: 'fridge' }],
    ['pastasauce', 'Pasta sauce', '🍅', 'pantry', 365, 5, 2.5, 'jar', { a: 'bolognese sauce|marinara|jar of sauce|curry sauce|stir fry sauce', op: 'fridge' }],
    ['mayo', 'Mayonnaise', '🥚', 'pantry', 180, 60, 2.5, 'jar', { a: 'mayo|aioli|salad cream', op: 'fridge' }],
    ['ketchup', 'Ketchup', '🍅', 'pantry', 365, 180, 2, 'jar', { a: 'tomato ketchup|bbq sauce|brown sauce|hot sauce', op: 'fridge' }],
    ['mustard', 'Mustard', '🌭', 'pantry', 365, 180, 2, 'jar', { op: 'fridge' }],
    ['jam', 'Jam', '🍓', 'pantry', 365, 30, 2.5, 'jar', { a: 'jelly|marmalade|preserves', op: 'fridge' }],
    ['olives', 'Olives', '🫒', 'pantry', 365, 14, 2.5, 'jar', { op: 'fridge' }],
    ['pickles', 'Pickles', '🥒', 'pantry', 365, 60, 2.5, 'jar', { a: 'gherkins|pickled onions|kimchi|sauerkraut|capers', op: 'fridge' }],
    ['coconutmilk', 'Coconut milk', '🥥', 'pantry', 730, 3, 1.5, 'tin', { a: 'coconut cream', op: 'fridge' }],
    ['stock', 'Stock', '🍲', 'pantry', 365, 4, 2, 'jar', { a: 'broth|chicken stock|veg stock|vegetable stock|bone broth', op: 'fridge' }],
    ['beans', 'Tinned beans', '🥫', 'pantry', 730, 3, 1, 'tin', { a: 'baked beans|kidney beans|black beans|cannellini beans|butter beans|beans|pinto beans', op: 'fridge' }],
    ['chickpeas', 'Chickpeas', '🥫', 'pantry', 730, 3, 1, 'tin', { a: 'garbanzo|garbanzo beans|tinned chickpeas', op: 'fridge' }],
    ['tinnedtom', 'Tinned tomatoes', '🥫', 'pantry', 730, 3, 1, 'tin', { a: 'chopped tomatoes|canned tomatoes|tinned tomato|crushed tomatoes', op: 'fridge' }],
    ['sweetcorn', 'Tinned sweetcorn', '🌽', 'pantry', 730, 3, 1, 'tin', { a: 'sweetcorn|canned corn', op: 'fridge' }],
    // dry goods
    ['rice', 'Rice', '🍚', 'pantry', 365, 0, 2, 'dry', { a: 'basmati|jasmine rice|risotto rice|brown rice|long grain rice' }],
    ['pasta', 'Pasta', '🍝', 'pantry', 365, 0, 1.5, 'dry', { a: 'spaghetti|penne|fusilli|macaroni|linguine|lasagne sheets|dried pasta' }],
    ['noodles', 'Noodles', '🍜', 'pantry', 365, 0, 1.5, 'dry', { a: 'egg noodles|rice noodles|ramen|udon|instant noodles' }],
    ['oats', 'Oats', '🥣', 'pantry', 180, 0, 2, 'dry', { a: 'porridge oats|porridge|rolled oats|granola|muesli' }],
    ['cereal', 'Cereal', '🥣', 'pantry', 120, 60, 3, 'dry', { a: 'cornflakes|cheerios|weetabix|bran flakes' }],
    ['flour', 'Flour', '🌾', 'pantry', 180, 0, 1.5, 'dry', { a: 'plain flour|self raising flour|all purpose flour|bread flour' }],
    ['lentils', 'Lentils', '🥣', 'pantry', 365, 0, 1.5, 'dry', { a: 'red lentils|split peas|green lentils' }],
    ['quinoa', 'Quinoa', '🌾', 'pantry', 365, 0, 3, 'dry', { a: 'couscous|bulgur|bulgur wheat' }],
    ['crackers', 'Crackers', '🍘', 'pantry', 90, 21, 2, 'dry', { a: 'rice cakes|oatcakes|breadsticks' }],
    ['nuts', 'Nuts', '🥜', 'pantry', 90, 30, 3, 'dry', { a: 'almonds|cashews|walnuts|peanuts|seeds|pine nuts|trail mix' }],
    ['peanutbutter', 'Peanut butter', '🥜', 'pantry', 180, 90, 3, 'jar', { a: 'nut butter|almond butter' }],
    ['honey', 'Honey', '🍯', 'pantry', 730, 365, 4, 'jar', { a: 'maple syrup|golden syrup|agave' }],
    ['crisps', 'Crisps', '🥔', 'pantry', 60, 3, 1.5, 'treat', { a: 'potato chips|tortilla chips|popcorn|pretzels' }],
    ['chocolate', 'Chocolate', '🍫', 'pantry', 180, 30, 2, 'treat', { a: 'chocolate bar|cookies|biscuits' }],
    // freezer
    ['peas', 'Frozen peas', '🟢', 'freezer', 365, 0, 1.5, 'frozen', { a: 'peas|petits pois' }],
    ['frozenveg', 'Frozen veg', '🥦', 'freezer', 365, 0, 2, 'frozen', { a: 'mixed veg|frozen vegetables|frozen spinach|frozen sweetcorn|stir fry veg' }],
    ['frozenberries', 'Frozen berries', '🍓', 'freezer', 365, 0, 3, 'frozen', { a: 'frozen fruit|frozen mango|smoothie mix' }],
    ['icecream', 'Ice cream', '🍨', 'freezer', 180, 60, 4, 'frozen', { a: 'ice lollies|sorbet|gelato|frozen yoghurt' }],
    ['fishfingers', 'Fish fingers', '🐟', 'freezer', 180, 0, 3, 'frozen', { a: 'fish sticks|breaded fish|fish cakes' }],
    ['frozenpizza', 'Frozen pizza', '🍕', 'freezer', 180, 0, 4, 'frozen', { a: 'pizza' }],
    ['chips', 'Oven chips', '🍟', 'freezer', 365, 0, 2.5, 'frozen', { a: 'fries|frozen chips|french fries|potato wedges|hash browns' }],
    ['dumplings', 'Dumplings', '🥟', 'freezer', 180, 0, 4, 'frozen', { a: 'gyoza|potstickers|bao|spring rolls' }],
    ['frozenprawns', 'Frozen prawns', '🦐', 'freezer', 180, 0, 6, 'frozen', { a: 'frozen shrimp' }],
    // drinks
    ['wine', 'Wine', '🍷', 'pantry', 365, 4, 10, 'drink', { a: 'red wine|white wine|rose|prosecco|sparkling wine', op: 'fridge', f: 0 }],
    ['beer', 'Beer', '🍺', 'pantry', 180, 1, 2, 'drink', { a: 'lager|cider|ale|beers' }],
  ];

  const CATALOGUE = ROWS.map((r) => {
    const o = r[8] || {};
    const g = GROUP[r[7]];
    return {
      id: r[0], name: r[1], emoji: r[2], place: r[3], days: r[4], opened: r[5] || 0, price: r[6], group: r[7],
      aliases: o.a ? o.a.split('|') : [], tip: o.tip || '', openPlace: o.op || null,
      freeze: o.f !== undefined ? o.f : g.freeze, thaw: g.thaw,
    };
  });
  const CAT = {};
  for (const c of CATALOGUE) CAT[c.id] = c;

  /** The "Weekly shop" grid: what most baskets have. */
  const WEEKLY = ['milk', 'eggs', 'bread', 'bananas', 'apples', 'berries', 'spinach', 'saladbag', 'tomatoes', 'cucumber', 'peppers', 'mushrooms', 'broccoli', 'carrots', 'onions', 'potatoes', 'chicken', 'mince', 'salmon', 'ham', 'cheddar', 'yoghurt', 'butter', 'pasta'];

  /* ------------------------------------------------------------------ *
   * Text and ids
   * ------------------------------------------------------------------ */

  // Control characters, zero-width marks and bidi overrides are removed from
  // anything typed or read (a name like "‮milk" would draw backwards on
  // every phone). The zero-width joiner stays: some emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters, cut on a whole character. Cut
   *  before any pattern runs, so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A name for a person or a food: has to have a letter, digit or emoji. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function cleanName(v) { return cleanText(v, LIMITS.memberName); }
  function cleanEmoji(v) { return EMOJI.indexOf(v) >= 0 ? v : null; }
  /** A food's emoji: one emoji (a ZWJ sequence counts as one), else null. */
  function cleanFoodEmoji(v) {
    if (typeof v !== 'string' || v.length > 24) return null;
    const s = v.replace(STRIP, '').trim();
    if (!/^\p{Extended_Pictographic}/u.test(s)) return null;
    if (/[\p{L}\p{N}<>&"'\s]/u.test(s.replace(/[⃣️]/g, ''))) return null;
    let n = 0;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) { for (const _ of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)) n++; } else n = 1;
    return n === 1 ? s : null;
  }
  function cleanPlace(v) { return PLACE_IDS.indexOf(v) >= 0 ? v : null; }
  function cleanQty(v) {
    const n = typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= 1 && n <= LIMITS.qty ? n : null;
  }

  const ITEM_ID = /^i[a-z0-9]{6,12}$/;
  const EVENT_ID = /^e[a-z0-9]{6,12}$/;
  const MEMBER_ID = /^m[a-z0-9]{6,12}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isItemId = (v) => typeof v === 'string' && ITEM_ID.test(v);
  const isEventId = (v) => typeof v === 'string' && EVENT_ID.test(v);
  const isMemberId = (v) => typeof v === 'string' && MEMBER_ID.test(v);
  function isDate(v) {
    if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
    const ms = Date.parse(v + 'T00:00:00Z');
    return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
  }

  /** A short random id from an unambiguous alphabet. `rand(n)` -> 0..n-1. */
  function newId(prefix, rand) {
    const A = 'abcdefghijkmnpqrstuvwxyz23456789';
    const r = rand || ((n) => Math.floor(Math.random() * n));
    let s = prefix;
    for (let i = 0; i < 9; i++) s += A[r(A.length)];
    return s;
  }

  function fail(status, message, extra) {
    const e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) Object.assign(e, extra);
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  /** "a", "a and b", "a, b and c". */
  function nameList(names) {
    if (names.length <= 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function money(usd) {
    const n = Math.max(0, Number(usd) || 0);
    return '$' + (n >= 10 ? Math.round(n) : n.toFixed(n < 1 && n > 0 ? 2 : 0).replace(/\.00$/, ''));
  }
  /** FNV-1a, 32 bits, finalised - for the example kitchen's deterministic history. */
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ *
   * Days, in the kitchen's own time zone
   * ------------------------------------------------------------------ */

  function cleanTz(tz) {
    if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; }
  }
  const fmtCache = {};
  /** The calendar date at `ms` in `tz`, as 'YYYY-MM-DD'. "Today" is always
   *  the kitchen's, not the server's or the phone's. */
  function localDate(ms, tz) {
    const z = cleanTz(tz);
    const f = fmtCache[z] || (fmtCache[z] = new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }));
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    return p.year + '-' + p.month + '-' + p.day;
  }
  const DAY_MS = 86400000;
  const dateMs = (d) => Date.parse(d + 'T00:00:00Z');
  const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(d, n) { return isoDate(dateMs(d) + n * DAY_MS); }
  /** Whole days from a to b ('YYYY-MM-DD'), b - a. */
  function daysBetween(a, b) { return Math.round((dateMs(b) - dateMs(a)) / DAY_MS); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /** "Wed 8 Oct" (the year when it is not this one). */
  function dateLabel(d, today) {
    const x = new Date(dateMs(d));
    const s = WEEKDAYS[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + MONTHS[x.getUTCMonth()];
    return today && d.slice(0, 4) !== today.slice(0, 4) ? s + ' ' + d.slice(0, 4) : s;
  }
  /** "today", "tomorrow", "in 3 days", "2 days ago". */
  function relDays(n) {
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? 'in ' + n + ' days' : -n + ' days ago';
  }

  /* ------------------------------------------------------------------ *
   * The catalogue: lookups and type-ahead
   * ------------------------------------------------------------------ */

  const fold = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();
  const singular = (s) => s.replace(/(oes|ies|s)$/, (m) => (m === 'ies' ? 'y' : m === 'oes' ? 'o' : ''));
  const EXACT = {};
  for (const c of CATALOGUE) {
    for (const n of [c.name].concat(c.aliases)) {
      const k = fold(n);
      if (!EXACT[k]) EXACT[k] = c.id;
      const s = singular(k);
      if (!EXACT[s]) EXACT[s] = c.id;
    }
  }
  /** The catalogue entry a name means, when it plainly means one. */
  function catFor(name) {
    const k = fold(name);
    if (!k) return null;
    return CAT[EXACT[k] || EXACT[singular(k)] || ''] || null;
  }
  /** Type-ahead: entries whose name or an alias starts with, or contains a
   *  word starting with, what was typed - best first. */
  function search(q, limit) {
    const k = fold(q);
    if (!k) return [];
    const out = [];
    for (const c of CATALOGUE) {
      let best = 9;
      let len = 99;
      const names = [c.name].concat(c.aliases);
      for (let i = 0; i < names.length; i++) {
        const n = fold(names[i]);
        const r = n === k ? 0 : n.startsWith(k) ? 1 : (' ' + n).includes(' ' + k) ? 2 : n.includes(k) ? 3 : 9;
        const score = r + (i ? 0.5 : 0);
        if (score < best || (score === best && n.length < len)) { best = score; len = n.length; }
      }
      if (best < 9) out.push({ c: c, s: best, len: len });
    }
    // Best kind of match first, then the shortest thing it matched ("chick"
    // finds chicken before chicken stock).
    out.sort((a, b) => Math.floor(a.s) - Math.floor(b.s) || a.len - b.len || a.s - b.s || (a.c.name < b.c.name ? -1 : 1));
    // A match in the middle of a word ("ber" in iceberg) only when the
    // better kinds are thin.
    const good = out.filter((x) => x.s < 3);
    return (good.length >= 3 ? good : out).slice(0, limit || 8).map((x) => x.c);
  }

  /** How many days a food keeps where it is put. Unknown food: five days in
   *  the fridge, two weeks in the pantry, three months frozen. */
  function shelfDays(cat, place, opened) {
    if (place === 'freezer') return cat ? (cat.place === 'freezer' ? cat.days : (cat.freeze || 30)) : 90;
    if (!cat) return place === 'pantry' ? 14 : 5;
    if (opened && cat.opened) return Math.min(cat.days, cat.opened);
    return cat.days;
  }
  function priceOf(cat, leftover) {
    if (cat) return cat.price;
    return leftover ? GROUP.cooked.price : 3;
  }

  /* ------------------------------------------------------------------ *
   * One item, cleaned - typed, tapped, read from a photo, or brought online
   * ------------------------------------------------------------------ */

  /**
   * raw: {id?, name, emoji?, place?, qty?, cat? | catalogueId?, use? |
   *       daysLeft?, added?, opened?, frozen?, leftover?}
   * ctx: {today, rand, keepId}
   * Throws a 400 for an item with no name; everything else falls back to the
   * catalogue's answer (or a plain default) rather than refusing.
   */
  function cleanItem(raw, ctx) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const today = ctx.today;
    const named = cleanText(r.name, LIMITS.itemName);
    const wanted = typeof r.cat === 'string' ? r.cat : typeof r.catalogueId === 'string' ? r.catalogueId : '';
    let cat = Object.prototype.hasOwnProperty.call(CAT, wanted) ? CAT[wanted] : null;
    if (!cat && named) cat = catFor(named);
    const name = named || (cat ? cat.name : '');
    if (!name) throw fail(400, 'Add the food’s name.');
    const place = cleanPlace(r.place) || (cat ? cat.place : 'fridge');
    const inRange = (d, lo, hi) => isDate(d) && daysBetween(today, d) >= lo && daysBetween(today, d) <= hi;
    const opened = inRange(r.opened, -400, 0) ? r.opened : null;
    const frozen = place === 'freezer' && inRange(r.frozen, -800, 0) ? r.frozen : null;
    let use = null;
    if (inRange(r.use, -400, 1100)) use = r.use;
    else {
      const n = typeof r.daysLeft === 'string' && /^\s*-?\d{1,4}\s*$/.test(r.daysLeft) ? Number(r.daysLeft) : r.daysLeft;
      if (Number.isInteger(n) && n >= -60 && n <= 1100) use = addDays(today, n);
    }
    if (!use) use = addDays(today, shelfDays(cat, place, opened));
    const emoji = cleanFoodEmoji(r.emoji) || (cat ? cat.emoji : (r.leftover === true ? '🍲' : '🍽️'));
    return {
      id: ctx.keepId && isItemId(r.id) ? r.id : newId('i', ctx.rand),
      name: name,
      emoji: emoji,
      place: place,
      qty: cleanQty(r.qty) || 1,
      cat: cat ? cat.id : null,
      added: inRange(r.added, -800, 0) ? r.added : today,
      use: use,
      opened: opened,
      frozen: frozen,
      leftover: r.leftover === true || Boolean(cat && cat.id === 'leftovers'),
    };
  }

  /** Leftovers in one tap: a dish name and how many portions. */
  function leftovers(dish, portions, ctx) {
    const name = cleanText(dish, LIMITS.itemName);
    return cleanItem({ name: name ? name : 'Leftovers', cat: 'leftovers', emoji: '🍲', place: 'fridge', qty: portions, leftover: true, daysLeft: CAT.leftovers.days }, ctx);
  }

  /* ------------------------------------------------------------------ *
   * Bands and the headline
   * ------------------------------------------------------------------ */

  function daysLeft(item, today) { return daysBetween(today, item.use); }
  function bandOf(item, today) {
    const d = daysLeft(item, today);
    if (d < 0) return 'past';
    if (d === 0) return 'today';
    if (d === 1) return 'tomorrow';
    if (d <= 7) return 'week';
    return 'later';
  }
  const asList = (items) => (Array.isArray(items) ? items : Object.keys(items || {}).map((k) => items[k])).filter(Boolean);
  /** Most urgent first: by date, then frozen last among equals, then name. */
  function sortItems(list) {
    return list.slice().sort((a, b) => (a.use < b.use ? -1 : a.use > b.use ? 1 : 0) || ((a.place === 'freezer') - (b.place === 'freezer')) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }
  /** [{id, label, items}] in band order, empty bands left out. */
  function bands(items, today) {
    const by = {};
    for (const b of BANDS) by[b.id] = [];
    for (const it of sortItems(asList(items))) by[bandOf(it, today)].push(it);
    return BANDS.map((b) => ({ id: b.id, label: b.label, items: by[b.id] })).filter((b) => b.items.length);
  }
  function counts(items, today) {
    const out = { past: 0, today: 0, tomorrow: 0, week: 0, later: 0, total: 0 };
    for (const it of asList(items)) { out[bandOf(it, today)]++; out.total++; }
    return out;
  }
  /** "the spinach", "half a chicken", "2 yoghurts" - how a food reads in a sentence. */
  function phrase(item) {
    let n = item.name;
    if (/^[A-Z][a-z]/.test(n) && !/^[A-Z][a-z]+ [A-Z]/.test(n)) n = n[0].toLowerCase() + n.slice(1);
    if (/^(\d|half |a |an |some |the |my |our |leftover|last )/i.test(n)) return n;
    return 'the ' + n;
  }
  /** One line at the top of the board. */
  function headline(items, today) {
    const list = asList(items);
    if (!list.length) return 'Your kitchen is empty - add what’s in the fridge and Shelf Life sorts it.';
    const b = {};
    for (const x of bands(list, today)) b[x.id] = x.items;
    const names = (xs) => { const n = xs.slice(0, 3).map(phrase); return xs.length > 3 ? n.join(', ') + ' and ' + (xs.length - 3) + ' more' : nameList(n); };
    const parts = [];
    if (b.today) parts.push((b.today.length === 1 ? '1 thing' : b.today.length + ' things') + ' to use today - ' + names(b.today) + '.');
    if (b.past) parts.push(b.past.length === 1 ? cap(phrase(b.past[0])) + ' is past its date - check it before you eat it.' : b.past.length + ' things are past their date - check them.');
    if (!b.today && b.tomorrow) parts.push('Nothing has to go today. Tomorrow: ' + names(b.tomorrow) + '.');
    if (!parts.length && b.week) parts.push('Nothing urgent. Next up this week: ' + names(b.week) + '.');
    if (!parts.length) return 'All good - nothing goes off this week. 🎉';
    return parts.join(' ');
  }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  /* ------------------------------------------------------------------ *
   * Actions. Each returns {patch: {set, del}, msg} and changes nothing
   * itself; applyPatch applies one to a kitchen object.
   * ------------------------------------------------------------------ */

  function itemOf(k, iid) {
    const it = k && k.items && Object.prototype.hasOwnProperty.call(k.items, iid) ? k.items[iid] : null;
    if (!it) throw fail(404, 'That’s not in the kitchen any more.');
    return it;
  }
  const copy = (o) => JSON.parse(JSON.stringify(o));

  function applyPatch(k, patch) {
    if (!patch) return k;
    for (const key of Object.keys(patch.set || {})) {
      const [map, id] = key.split('.');
      if (!k[map] || typeof k[map] !== 'object') k[map] = {};
      k[map][id] = copy(patch.set[key]);
    }
    for (const key of patch.del || []) {
      const [map, id] = key.split('.');
      if (k[map]) delete k[map][id];
    }
    return k;
  }

  /** Add one or many. The same food, place, date and state as an item
   *  already there just adds to its quantity. */
  function addItems(k, raws, ctx) {
    const list = Array.isArray(raws) ? raws : [raws];
    if (!list.length) throw fail(400, 'Add something.');
    if (list.length > LIMITS.addAtOnce) throw fail(400, 'That’s a lot at once - add up to ' + LIMITS.addAtOnce + ' at a time.');
    const items = copy(k.items || {});
    const set = {};
    const added = [];
    for (const raw of list) {
      const it = cleanItem(raw, { today: ctx.today, rand: ctx.rand });
      const same = Object.keys(items).map((id) => items[id]).find((x) => x.name.toLowerCase() === it.name.toLowerCase() && x.use === it.use && x.place === it.place && !x.opened && !it.opened && x.cat === it.cat && x.leftover === it.leftover);
      if (same) {
        same.qty = Math.min(LIMITS.qty, same.qty + it.qty);
        set['items.' + same.id] = same;
        added.push(same.id);
        continue;
      }
      if (Object.keys(items).length >= LIMITS.items) throw fail(409, 'A kitchen holds ' + LIMITS.items + ' things at most. Clear out a few first.');
      items[it.id] = it;
      set['items.' + it.id] = it;
      added.push(it.id);
    }
    return { patch: { set: set, del: [] }, added: added, msg: list.length === 1 ? 'Added ' + (items[added[0]] || {}).name : 'Added ' + plural(list.length, 'thing') };
  }

  /** Edit what was typed: name, emoji, quantity, where it is, its date. A
   *  move into or out of the freezer without a new date re-dates it the way
   *  Froze it / Thaw do. */
  function editItem(k, iid, b, ctx) {
    const cur = itemOf(k, iid);
    const body = b && typeof b === 'object' ? b : {};
    const next = copy(cur);
    if (body.name !== undefined) {
      const n = cleanText(body.name, LIMITS.itemName);
      if (!n) throw fail(400, 'Add the food’s name.');
      next.name = n;
    }
    if (body.emoji !== undefined) next.emoji = cleanFoodEmoji(body.emoji) || next.emoji;
    if (body.qty !== undefined) {
      const q = cleanQty(body.qty);
      if (!q) throw fail(400, 'Quantity is a number from 1 to ' + LIMITS.qty + '.');
      next.qty = q;
    }
    let msg = 'Saved';
    const place = body.place !== undefined ? cleanPlace(body.place) : null;
    if (body.place !== undefined && !place) throw fail(400, 'Fridge, freezer or pantry.');
    if (body.use !== undefined) {
      if (!isDate(body.use) || daysBetween(ctx.today, body.use) < -60 || daysBetween(ctx.today, body.use) > 1100) throw fail(400, 'Pick a date.');
      next.use = body.use;
    }
    if (place && place !== cur.place) {
      if (place === 'freezer' && body.use === undefined) return freeze(k, iid, ctx, next);
      if (cur.place === 'freezer' && body.use === undefined) return thaw(k, iid, ctx, next, place);
      next.place = place;
      if (place !== 'freezer') next.frozen = null;
    }
    return { patch: { set: { ['items.' + iid]: next }, del: [] }, msg: msg };
  }

  /** "I opened it": the clock restarts at the opened shelf life (never later
   *  than the date it had), and a jar moves to the fridge. */
  function open(k, iid, ctx) {
    const cur = itemOf(k, iid);
    const next = copy(cur);
    const cat = CAT[cur.cat] || null;
    next.opened = ctx.today;
    let msg;
    if (cat && cat.opened && cur.place !== 'freezer') {
      const by = addDays(ctx.today, cat.opened);
      if (by < next.use) next.use = by;
      msg = 'Opened - use within ' + plural(cat.opened, 'day') + ' (' + dateLabel(next.use, ctx.today) + ').';
    } else {
      msg = 'Marked as opened - its date stays ' + dateLabel(next.use, ctx.today) + '.';
    }
    if (cat && cat.openPlace && cur.place === 'pantry') { next.place = cat.openPlace; msg += ' Keep it in the fridge now.'; }
    return { patch: { set: { ['items.' + iid]: next }, del: [] }, msg: msg };
  }

  /** "Froze it": into the freezer, good for the food's freezer time from today. */
  function freeze(k, iid, ctx, base) {
    const cur = base || itemOf(k, iid);
    const next = copy(cur);
    const cat = CAT[cur.cat] || null;
    const days = cat ? (cat.freeze || 30) : (cur.leftover ? GROUP.cooked.freeze : 90);
    next.place = 'freezer';
    next.frozen = ctx.today;
    next.use = addDays(ctx.today, days);
    const poor = cat && !cat.freeze;
    const msg = 'In the freezer - good till ' + dateLabel(next.use, ctx.today) + '.' + (poor ? ' ' + cat.name + ' doesn’t freeze brilliantly - fine for cooking with.' : ' Thaw it in the fridge.');
    return { patch: { set: { ['items.' + iid]: next }, del: [] }, msg: msg };
  }

  /** "Thaw it": out of the freezer, to be used within a day or two. */
  function thaw(k, iid, ctx, base, place) {
    const cur = base || itemOf(k, iid);
    const next = copy(cur);
    const cat = CAT[cur.cat] || null;
    const days = cat ? cat.thaw : (cur.leftover ? 1 : 2);
    next.place = place && place !== 'freezer' ? place : 'fridge';
    next.frozen = null;
    next.use = addDays(ctx.today, days);
    return { patch: { set: { ['items.' + iid]: next }, del: [] }, msg: 'Thawing in the ' + next.place + ' - use it by ' + (days === 1 ? 'tomorrow' : dateLabel(next.use, ctx.today)) + '.' };
  }

  /** "+days": a date that was too cautious. Counted from today when the
   *  date has already passed, so +1 on "3 days past" means tomorrow. */
  function extend(k, iid, days, ctx) {
    const cur = itemOf(k, iid);
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw fail(400, 'Add 1 to 30 days.');
    const next = copy(cur);
    next.use = addDays(cur.use < ctx.today ? ctx.today : cur.use, n);
    return { patch: { set: { ['items.' + iid]: next }, del: [] }, msg: 'Now ' + dateLabel(next.use, ctx.today) + '.' };
  }

  /** Taken out by mistake (not eaten, not binned): no history. */
  function removeItem(k, iid) {
    const cur = itemOf(k, iid);
    return { patch: { set: {}, del: ['items.' + iid] }, msg: 'Took ' + cur.name + ' off the list.' };
  }

  /** Events older than the window, or past the cap (oldest first), to drop. */
  function pruneKeys(history, today, adding) {
    const list = asList(history).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const out = [];
    const cutoff = addDays(today, -LIMITS.historyDays);
    let keep = list.length + (adding || 0);
    for (const e of list) {
      if (e.date < cutoff || keep > LIMITS.history) { out.push('history.' + e.id); keep--; }
    }
    return out;
  }

  function eventFor(it, outcome, ctx, extra) {
    const cat = CAT[it.cat] || null;
    return Object.assign({
      id: newId('e', ctx.rand),
      iid: it.id,
      name: it.name,
      emoji: it.emoji,
      cat: it.cat,
      place: it.place,
      outcome: outcome,
      date: ctx.today,
      left: daysBetween(ctx.today, it.use),
      price: Math.round(priceOf(cat, it.leftover) * 100) / 100,
      by: ctx.by && isMemberId(ctx.by) ? ctx.by : null,
      at: new Date(ctx.now).toISOString(),
      snap: { use: it.use, added: it.added, opened: it.opened, frozen: it.frozen, leftover: it.leftover, place: it.place },
    }, extra || {});
  }

  /** "Ate it" / "Binned it": one of it gone (the item, when it was the last),
   *  and one line of history. */
  function done(k, iid, outcome, ctx) {
    if (outcome !== 'ate' && outcome !== 'binned') throw fail(400, 'Ate it or binned it.');
    const cur = itemOf(k, iid);
    const ev = eventFor(cur, outcome, ctx);
    const set = { ['history.' + ev.id]: ev };
    const del = pruneKeys(k.history, ctx.today, 1);
    if (cur.qty > 1) { const next = copy(cur); next.qty -= 1; set['items.' + iid] = next; } else del.push('items.' + iid);
    const msg = outcome === 'ate' ? (ev.left <= 1 ? 'Rescued ' + phrase(cur) + ' 🎉' : 'Ate ' + phrase(cur)) : 'Binned ' + phrase(cur) + ' - noted, no judgement';
    return { patch: { set: set, del: del }, event: ev, msg: msg };
  }

  /** "Cook this": one of each chosen item eaten, under the dish's name. */
  function cook(k, iids, title, ctx) {
    const ids = Array.isArray(iids) ? iids.filter((x, i, a) => isItemId(x) && a.indexOf(x) === i).slice(0, 20) : [];
    if (!ids.length) throw fail(400, 'Pick what you used.');
    const dish = clean(title, 60);
    const set = {};
    const del = pruneKeys(k.history, ctx.today, ids.length);
    const events = [];
    for (const id of ids) {
      const cur = itemOf(k, id);
      const ev = eventFor(cur, 'ate', ctx, dish ? { dish: dish } : {});
      set['history.' + ev.id] = ev;
      events.push(ev);
      if (cur.qty > 1) { const next = copy(cur); next.qty -= 1; set['items.' + id] = next; } else del.push('items.' + id);
    }
    return { patch: { set: set, del: del }, events: events, msg: 'Enjoy! ' + plural(ids.length, 'thing') + ' used up' + (dish ? ' in ' + dish : '') + ' 🍽️' };
  }

  /** Undo an Ate it / Binned it: the event goes and the item comes back. */
  function undo(k, eid, ctx) {
    const ev = k && k.history && Object.prototype.hasOwnProperty.call(k.history, eid) ? k.history[eid] : null;
    if (!ev) throw fail(404, 'Nothing to undo.');
    const set = {};
    const cur = k.items && k.items[ev.iid];
    if (cur) {
      const next = copy(cur); next.qty = Math.min(LIMITS.qty, next.qty + 1); set['items.' + cur.id] = next;
    } else {
      if (asList(k.items).length >= LIMITS.items) throw fail(409, 'The kitchen is full.');
      const s = ev.snap || {};
      set['items.' + ev.iid] = cleanItem({ id: ev.iid, name: ev.name, emoji: ev.emoji, cat: ev.cat, place: s.place || ev.place, qty: 1, use: s.use, added: s.added, opened: s.opened, frozen: s.frozen, leftover: s.leftover }, { today: ctx.today, rand: ctx.rand, keepId: true });
    }
    return { patch: { set: set, del: ['history.' + eid] }, msg: 'Undone - ' + ev.name + ' is back.' };
  }

  /* ------------------------------------------------------------------ *
   * A whole kitchen, cleaned (a phone's own, brought online)
   * ------------------------------------------------------------------ */

  function cleanEvent(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.outcome !== 'ate' && raw.outcome !== 'binned') return null;
    if (!isDate(raw.date) || raw.date > ctx.today || daysBetween(raw.date, ctx.today) > LIMITS.historyDays) return null;
    const name = cleanText(raw.name, LIMITS.itemName);
    if (!name) return null;
    const cat = typeof raw.cat === 'string' && Object.prototype.hasOwnProperty.call(CAT, raw.cat) ? raw.cat : null;
    const price = typeof raw.price === 'number' && isFinite(raw.price) && raw.price >= 0 && raw.price <= 200 ? Math.round(raw.price * 100) / 100 : priceOf(CAT[cat] || null, false);
    const left = Number.isInteger(raw.left) && Math.abs(raw.left) <= 1100 ? raw.left : 0;
    const at = typeof raw.at === 'string' && !isNaN(Date.parse(raw.at)) ? new Date(Date.parse(raw.at)).toISOString() : raw.date + 'T12:00:00.000Z';
    const ev = { id: isEventId(raw.id) ? raw.id : newId('e', ctx.rand), iid: isItemId(raw.iid) ? raw.iid : newId('i', ctx.rand), name: name, emoji: cleanFoodEmoji(raw.emoji) || (cat ? CAT[cat].emoji : '🍽️'), cat: cat, place: cleanPlace(raw.place) || 'fridge', outcome: raw.outcome, date: raw.date, left: left, price: price, by: null, at: at };
    const dish = clean(raw.dish, 60);
    if (dish) ev.dish = dish;
    return ev;
  }

  /** {name, tz, created, items: {id: item}, history: {id: event}} from
   *  whatever a phone sent: every item through cleanItem, every event
   *  bounded, the caps applied. */
  function cleanKitchen(raw, ctx) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = cleanText(r.name, LIMITS.kitchenName) || 'Our kitchen';
    const items = {};
    for (const it of asList(r.items).slice(0, LIMITS.items)) {
      try { const c = cleanItem(it, { today: ctx.today, rand: ctx.rand, keepId: true }); if (!items[c.id]) items[c.id] = c; } catch (e) { /* a nameless item is dropped */ }
    }
    const evs = asList(r.history).map((e) => cleanEvent(e, ctx)).filter(Boolean)
      .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, LIMITS.history);
    const history = {};
    for (const e of evs) if (!history[e.id]) history[e.id] = e;
    return { name: name, created: isDate(r.created) && r.created <= ctx.today ? r.created : ctx.today, items: items, history: history };
  }

  /* ------------------------------------------------------------------ *
   * Recipes, ranked by what is going off
   * ------------------------------------------------------------------ */

  // [id, title, emoji, minutes, uses (each a catalogue id, or a list of
  //  ids any one of which will do), nice to have, steps]. Salt, pepper and
  //  oil are assumed.
  const R = [
    ['omelette', 'Spinach and feta omelette', '🍳', 10, ['eggs', ['spinach', 'kale', 'rocket']], ['feta', 'cheddar', 'mushrooms', 'springonion', 'herbs'],
      ['Beat 3 eggs with a pinch of salt.', 'Wilt the greens in a hot pan with a little oil, then tip them out.', 'Pour in the eggs, swirl, and cook until just set.', 'Add the greens and crumbled cheese to one half, fold, and serve.']],
    ['frittata', 'Clear-the-fridge frittata', '🍳', 25, ['eggs', ['peppers', 'courgette', 'mushrooms', 'broccoli', 'spinach', 'asparagus', 'potatoes', 'greenbeans', 'leeks'], ['peppers', 'courgette', 'mushrooms', 'broccoli', 'spinach', 'asparagus', 'onions', 'tomatoes', 'kale']], ['cheddar', 'feta', 'parmesan', 'ham', 'bacon', 'herbs'],
      ['Heat the grill.', 'Soften the chopped veg in an ovenproof pan for 8 minutes.', 'Beat 6 eggs with salt and any cheese, pour over the veg.', 'Cook on a low heat for 6 minutes until the edges set.', 'Finish under the grill until golden. Slice like a cake.']],
    ['bananabread', 'Banana bread', '🍌', 60, ['bananas', 'eggs', 'flour'], ['butter', 'nuts', 'chocolate', 'yoghurt'],
      ['Heat the oven to 180°C / 350°F and line a loaf tin.', 'Mash 3 brown bananas with 2 eggs and 75g melted butter or oil.', 'Stir in 200g flour, 100g sugar and a teaspoon of baking powder.', 'Fold in nuts or chocolate if you have them.', 'Bake 50 minutes, until a skewer comes out clean.']],
    ['smoothie', 'Use-it-up smoothie', '🥤', 5, [['bananas', 'berries', 'blueberries', 'frozenberries', 'mango', 'peaches', 'spinach', 'kiwi', 'pears'], ['yoghurt', 'greekyog', 'milk', 'oatmilk', 'juice']], ['oats', 'honey', 'peanutbutter', 'spinach'],
      ['Put the fruit (and a handful of spinach if it is wilting) in a blender.', 'Add the yoghurt or milk.', 'Blitz until smooth, loosening with water if needed.', 'Taste, sweeten with honey if you like, and drink straight away.']],
    ['friedrice', 'Egg fried rice', '🍚', 15, ['cookedrice', 'eggs', ['peas', 'frozenveg', 'carrots', 'peppers', 'springonion', 'beansprouts', 'corn', 'sweetcorn', 'broccoli', 'greenbeans']], ['ham', 'prawns', 'roastchicken', 'chilli', 'ginger', 'garlic'],
      ['Get a wok or big pan very hot with a little oil.', 'Fry the chopped veg for 3 minutes.', 'Add the cold rice and fry, tossing, until it crackles.', 'Push it aside, scramble 2 eggs in the space, then mix through.', 'Season with soy sauce and finish with spring onion.']],
    ['pasta', 'Pasta with whatever’s going', '🍝', 20, ['pasta', ['spinach', 'mushrooms', 'courgette', 'peppers', 'tomatoes', 'broccoli', 'asparagus', 'kale', 'greenbeans', 'leeks']], ['garlic', 'parmesan', 'cream', 'bacon', 'chilli', 'lemon'],
      ['Boil the pasta in well-salted water.', 'Meanwhile soften garlic and the chopped veg in olive oil.', 'Add a ladle of pasta water and let it bubble.', 'Toss the drained pasta through with cheese and plenty of pepper.']],
    ['stirfry', 'Chicken stir-fry', '🥡', 20, ['chicken', ['peppers', 'broccoli', 'carrots', 'beansprouts', 'pakchoi', 'mushrooms', 'springonion', 'frozenveg', 'greenbeans']], ['noodles', 'rice', 'ginger', 'garlic', 'chilli', 'cabbage'],
      ['Slice the chicken thinly and fry in a very hot pan until cooked through. Lift out.', 'Stir-fry the veg for 3-4 minutes, keeping some crunch.', 'Add garlic, ginger and chilli for a minute.', 'Return the chicken with soy sauce and a splash of water.', 'Serve over noodles or rice.']],
    ['quesadillas', 'Chicken quesadillas', '🌮', 15, ['roastchicken', 'wraps', ['cheddar', 'mozzarella']], ['peppers', 'salsa', 'sourcream', 'guacamole', 'springonion', 'sweetcorn', 'beans'],
      ['Scatter cheese, shredded chicken and any veg over half of each wrap.', 'Fold over and press down.', 'Dry-fry 2-3 minutes a side until crisp and melted.', 'Cut into wedges; serve with salsa or sour cream.']],
    ['bubble', 'Bubble and squeak', '🥔', 20, ['potatoes', ['cabbage', 'kale', 'sprouts', 'spinach', 'broccoli', 'carrots', 'parsnips', 'leeks']], ['eggs', 'onions', 'bacon', 'butter'],
      ['Boil or microwave the potatoes until soft, then roughly mash.', 'Fry the greens and onion in butter until soft.', 'Mix into the potato and press into the pan.', 'Fry until a crust forms, flip in pieces, crisp again.', 'Top with a fried egg.']],
    ['soup', 'Big pot of veg soup', '🥣', 40, [['carrots', 'celery', 'leeks', 'potatoes', 'courgette', 'butternut', 'broccoli', 'cauliflower', 'parsnips', 'sweetpot'], ['carrots', 'celery', 'leeks', 'potatoes', 'courgette', 'butternut', 'broccoli', 'cauliflower', 'parsnips', 'onions', 'sweetpot', 'spinach', 'kale']], ['onions', 'stock', 'tinnedtom', 'beans', 'herbs', 'garlic', 'lentils'],
      ['Soften a chopped onion in oil for 5 minutes.', 'Add every chopped veg that needs using and stir for a few minutes.', 'Cover with stock (or water and a stock cube) and simmer 20-25 minutes.', 'Blend smooth or leave chunky. Season well.', 'Freeze what you won’t eat in two days.']],
    ['shakshuka', 'Shakshuka', '🍳', 25, ['eggs', ['tinnedtom', 'passata', 'tomatoes'], ['peppers', 'onions']], ['feta', 'herbs', 'chilli', 'bread', 'garlic', 'spinach'],
      ['Soften sliced pepper and onion in oil for 8 minutes.', 'Add garlic, a pinch of cumin and chilli, then the tomatoes. Simmer 10 minutes.', 'Make little wells and crack in the eggs.', 'Cover and cook until the whites set.', 'Scatter with feta and herbs; serve with bread.']],
    ['greeksalad', 'Greek salad', '🥗', 10, [['tomatoes'], 'cucumber', 'feta'], ['olives', 'onions', 'peppers', 'lettuce', 'herbs'],
      ['Chop the tomatoes and cucumber into big chunks.', 'Add thinly sliced onion and peppers if you have them.', 'Top with a slab of feta and olives.', 'Dress with olive oil, a little vinegar and oregano.']],
    ['caprese', 'Tomato and mozzarella', '🍅', 5, ['tomatoes', 'mozzarella'], ['herbs', 'pesto', 'avocado', 'bread'],
      ['Slice the tomatoes and mozzarella.', 'Layer them on a plate.', 'Add basil or a spoon of pesto.', 'Olive oil, salt, pepper - done.']],
    ['pesto', 'Pesto pasta', '🌿', 15, ['pasta', 'pesto'], ['spinach', 'parmesan', 'greenbeans', 'tomatoes', 'roastchicken', 'peas'],
      ['Cook the pasta, adding green beans or peas for the last 3 minutes.', 'Drain, keeping a splash of water.', 'Stir through the pesto, a handful of spinach and the water.', 'Finish with parmesan.']],
    ['chilli', 'Chilli con carne', '🌶️', 45, ['mince', ['beans', 'chickpeas'], ['tinnedtom', 'passata']], ['onions', 'peppers', 'chilli', 'sourcream', 'cheddar', 'rice', 'garlic'],
      ['Brown the mince with a chopped onion and pepper.', 'Add garlic, chilli powder and cumin for a minute.', 'Add the tomatoes and drained beans; simmer 30 minutes.', 'Serve with rice, cheese and sour cream. It freezes well.']],
    ['bolognese', 'Spaghetti bolognese', '🍝', 40, ['mince', 'pasta', ['passata', 'tinnedtom', 'pastasauce']], ['carrots', 'onions', 'celery', 'garlic', 'mushrooms', 'parmesan'],
      ['Soften finely chopped onion, carrot and celery for 8 minutes.', 'Add the mince and brown it.', 'Add garlic and the tomatoes; simmer 25 minutes.', 'Toss with the cooked spaghetti and top with parmesan.']],
    ['traybake', 'Salmon tray bake', '🐟', 25, ['salmon', ['potatoes', 'asparagus', 'broccoli', 'greenbeans', 'courgette', 'tomatoes', 'peppers']], ['lemon', 'herbs', 'garlic'],
      ['Heat the oven to 200°C / 400°F.', 'Roast halved potatoes for 15 minutes (skip if you have none).', 'Add the other veg and the salmon, with oil, salt and lemon.', 'Roast 12 minutes more, until the fish flakes.']],
    ['fishtacos', 'Fish tacos', '🌮', 20, [['whitefish', 'salmon', 'prawns', 'fishfingers', 'frozenprawns'], 'wraps'], ['cabbage', 'lemon', 'sourcream', 'avocado', 'herbs', 'salsa', 'lettuce'],
      ['Cook the fish (pan-fry, or bake fish fingers).', 'Shred cabbage or lettuce finely.', 'Warm the wraps in a dry pan.', 'Fill with fish, crunch, a squeeze of lime and a spoon of sour cream.']],
    ['prawnnoodles', 'Prawn noodles', '🍜', 15, [['prawns', 'frozenprawns'], 'noodles', ['pakchoi', 'beansprouts', 'springonion', 'peppers', 'carrots', 'frozenveg', 'broccoli']], ['chilli', 'ginger', 'garlic', 'lemon'],
      ['Cook the noodles and drain.', 'Stir-fry garlic, ginger and the veg for 2 minutes.', 'Add the prawns until pink.', 'Toss in the noodles with soy and a squeeze of lime.']],
    ['mushroomtoast', 'Garlic mushrooms on toast', '🍄', 10, ['mushrooms', ['bread', 'bagels', 'rolls']], ['butter', 'garlic', 'herbs', 'eggs', 'cream'],
      ['Fry sliced mushrooms in butter on a high heat until golden.', 'Add garlic for the last minute.', 'Toast the bread.', 'Pile on the mushrooms with parsley; a poached egg on top is lovely.']],
    ['toastie', 'Cheese toastie', '🧀', 10, ['bread', ['cheddar', 'mozzarella', 'brie']], ['ham', 'tomatoes', 'onions', 'turkey', 'pickles'],
      ['Butter the outsides of two slices.', 'Fill with cheese and anything else that needs eating.', 'Cook in a pan, pressed down, 3 minutes a side.', 'Cut corner to corner.']],
    ['frenchtoast', 'French toast', '🍞', 15, ['bread', 'eggs', 'milk'], ['berries', 'blueberries', 'bananas', 'honey', 'butter'],
      ['Whisk 2 eggs with a splash of milk and a pinch of cinnamon.', 'Soak slightly stale bread in it for a few seconds a side.', 'Fry in butter until golden.', 'Top with fruit and honey.']],
    ['oats', 'Overnight oats', '🥣', 5, ['oats', ['milk', 'oatmilk', 'yoghurt', 'greekyog']], ['berries', 'blueberries', 'bananas', 'peanutbutter', 'honey', 'apples'],
      ['Mix half a cup of oats with the same of milk or yoghurt.', 'Stir in honey or peanut butter.', 'Cover and leave in the fridge overnight.', 'Top with chopped fruit in the morning.']],
    ['parfait', 'Fruit and yoghurt pots', '🍓', 5, [['yoghurt', 'greekyog'], ['berries', 'blueberries', 'grapes', 'mango', 'kiwi', 'peaches', 'bananas', 'apples', 'pears', 'cherries', 'pineapple', 'melon']], ['honey', 'oats', 'nuts'],
      ['Chop the fruit that needs eating; soft fruit can be mashed.', 'Spoon some yoghurt into glasses or bowls.', 'Layer in the fruit, then more yoghurt.', 'Finish with oats or nuts and a drizzle of honey.']],
    ['jacket', 'Loaded baked potatoes', '🥔', 60, ['potatoes', ['cheddar', 'beans', 'sourcream', 'cottage', 'tuna', 'coleslaw']], ['springonion', 'butter', 'bacon'],
      ['Prick the potatoes and rub with oil and salt.', 'Bake at 200°C / 400°F for an hour - or microwave 8-10 minutes, then crisp in the oven for 10.', 'Split and fluff the insides with butter.', 'Load up with whatever needs eating, and add spring onion.']],
    ['curry', 'Use-it-up curry', '🍛', 35, [['chicken', 'roastchicken', 'chickpeas', 'butternut', 'cauliflower', 'sweetpot', 'prawns', 'tofu'], 'coconutmilk', ['spinach', 'peppers', 'onions', 'kale', 'tomatoes', 'peas']], ['rice', 'pitta', 'herbs', 'garlic', 'ginger', 'lemon'],
      ['Soften an onion with garlic and ginger.', 'Add 2 tablespoons of curry paste or powder and stir for a minute.', 'Add the main ingredient and the coconut milk; simmer 15-20 minutes until cooked.', 'Stir in the greens to wilt.', 'Serve with rice or naan.']],
    ['halloumiwrap', 'Halloumi wraps', '🌯', 15, ['halloumi', 'wraps', ['peppers', 'lettuce', 'saladbag', 'tomatoes', 'cucumber', 'rocket']], ['hummus', 'lemon', 'herbs'],
      ['Slice the halloumi and fry until golden on both sides.', 'Warm the wraps.', 'Spread with hummus, add salad and the halloumi.', 'Squeeze over lemon and roll up.']],
    ['chickensalad', 'Chicken salad', '🥗', 10, ['roastchicken', ['lettuce', 'saladbag', 'rocket', 'spinach']], ['tomatoes', 'cucumber', 'avocado', 'mayo', 'croutons', 'parmesan'],
      ['Shred the chicken.', 'Toss the leaves with chopped tomato, cucumber and avocado.', 'Dress with oil and lemon (or a spoon of mayo let down with water).', 'Top with the chicken.']],
    ['wrappizza', 'Wrap pizzas', '🍕', 15, [['wraps', 'pitta'], ['passata', 'pastasauce', 'tinnedtom'], ['mozzarella', 'cheddar']], ['ham', 'salami', 'peppers', 'mushrooms', 'olives', 'tomatoes', 'sweetcorn'],
      ['Heat the oven to 220°C / 425°F.', 'Spread each wrap thinly with tomato.', 'Top with cheese and whatever needs using.', 'Bake 8 minutes, until crisp.']],
    ['pancakes', 'Pancakes', '🥞', 20, ['eggs', 'milk', 'flour'], ['bananas', 'berries', 'blueberries', 'butter', 'lemon', 'honey'],
      ['Whisk 1 egg, 300ml milk and 100g flour into a smooth batter.', 'Heat a pan with a little butter.', 'Pour in a thin layer, cook 1 minute, flip, 30 seconds more.', 'Fill or top with fruit.']],
    ['carbonara', 'Bacon carbonara', '🍝', 20, ['pasta', 'eggs', ['bacon', 'ham']], ['parmesan', 'cream', 'peas', 'garlic'],
      ['Cook the pasta.', 'Fry the bacon until crisp.', 'Beat 2 eggs with lots of grated cheese and pepper.', 'Off the heat, toss the hot pasta with the bacon, then the egg mix and a splash of pasta water, until silky.']],
    ['sandwich', 'Proper sandwich', '🥪', 5, [['bread', 'rolls', 'bagels'], ['ham', 'turkey', 'salami', 'roastchicken', 'cheddar'], ['lettuce', 'saladbag', 'tomatoes', 'cucumber', 'rocket', 'spinach']], ['mayo', 'mustard', 'pickles', 'avocado'],
      ['Toast the bread if it is past its best.', 'Spread with mayo or mustard.', 'Layer the filling with the salad that needs eating.', 'Press, cut, eat.']],
    ['dipplate', 'Hummus and dippers', '🥙', 5, ['hummus', ['carrots', 'cucumber', 'peppers', 'celery']], ['pitta', 'crackers', 'olives', 'falafel'],
      ['Cut the veg into sticks.', 'Warm the pitta.', 'Spoon the hummus into a bowl with a drizzle of oil.', 'Dig in.']],
    ['roastveg', 'Roast veg tray', '🥕', 40, [['butternut', 'sweetpot', 'carrots', 'peppers', 'courgette', 'aubergine', 'beetroot', 'potatoes', 'parsnips', 'cauliflower'], ['butternut', 'sweetpot', 'carrots', 'peppers', 'courgette', 'aubergine', 'beetroot', 'onions', 'parsnips', 'broccoli', 'tomatoes']], ['feta', 'halloumi', 'herbs', 'garlic', 'chickpeas'],
      ['Heat the oven to 200°C / 400°F.', 'Cut the veg into similar chunks.', 'Toss with oil, salt and garlic on a big tray.', 'Roast 30-35 minutes, turning once.', 'Crumble over feta or add halloumi for the last 10 minutes.']],
    ['cauliflowercheese', 'Cauliflower cheese', '🥦', 35, [['cauliflower', 'broccoli'], 'cheddar', 'milk'], ['butter', 'flour', 'mustard'],
      ['Boil the florets for 5 minutes and drain.', 'Melt 30g butter, stir in 30g flour, then whisk in 400ml milk until thick.', 'Melt in most of the cheese and a little mustard.', 'Pour over, top with the rest of the cheese, bake 20 minutes at 200°C / 400°F.']],
    ['dhal', 'Lentil dhal', '🥣', 30, ['lentils', ['tinnedtom', 'tomatoes', 'passata'], ['spinach', 'kale']], ['coconutmilk', 'onions', 'garlic', 'ginger', 'rice', 'lemon'],
      ['Soften onion, garlic and ginger with a spoon of curry powder.', 'Add 200g red lentils, the tomatoes and 700ml water.', 'Simmer 20 minutes, stirring, until thick.', 'Stir in the greens to wilt and finish with lemon.']],
    ['sausagebake', 'Sausage and bean bake', '🌭', 30, ['sausages', ['beans', 'tinnedtom']], ['onions', 'peppers', 'bread', 'potatoes'],
      ['Brown the sausages in an ovenproof pan.', 'Add sliced onion and pepper and soften.', 'Add the beans and tomatoes, then bake 20 minutes at 200°C / 400°F.', 'Serve with crusty bread.']],
    ['steaksalad', 'Steak and salad', '🥩', 20, ['steak', ['saladbag', 'rocket', 'lettuce', 'spinach']], ['potatoes', 'mushrooms', 'tomatoes', 'parmesan'],
      ['Bring the steak to room temperature and season well.', 'Sear in a very hot pan, 2-3 minutes a side for medium-rare.', 'Rest 5 minutes, then slice.', 'Serve on the dressed leaves.']],
    ['porkapple', 'Pork chops with apples', '🍎', 25, ['pork', ['apples', 'pears']], ['potatoes', 'cabbage', 'onions', 'mustard'],
      ['Season and fry the chops 4-5 minutes a side until cooked through. Rest.', 'In the same pan fry apple wedges and sliced onion until soft.', 'Add a splash of water and a spoon of mustard to make a sauce.', 'Serve with mash or greens.']],
    ['avotoast', 'Avocado toast', '🥑', 5, ['avocado', ['bread', 'bagels']], ['eggs', 'chilli', 'lemon', 'feta', 'tomatoes'],
      ['Toast the bread.', 'Mash the avocado with lemon, salt and chilli.', 'Spread thickly.', 'Top with an egg or crumbled feta.']],
    ['tunabake', 'Tuna pasta bake', '🐟', 30, ['tuna', 'pasta', ['cheddar', 'mozzarella']], ['sweetcorn', 'passata', 'peppers', 'broccoli', 'peas', 'cream'],
      ['Cook the pasta 2 minutes short.', 'Mix with tuna, sweetcorn, any veg and passata or a little cream.', 'Top with cheese.', 'Bake 15 minutes at 200°C / 400°F until bubbling.']],
    ['crumble', 'Fruit crumble', '🫐', 40, [['berries', 'blueberries', 'apples', 'pears', 'frozenberries', 'peaches', 'cherries'], 'flour', 'butter'], ['oats', 'custard', 'icecream'],
      ['Heat the oven to 190°C / 375°F.', 'Chop the fruit into a dish with a spoon of sugar.', 'Rub 100g butter into 150g flour, then stir in 75g sugar (and oats).', 'Scatter over the fruit and bake 30 minutes until golden.']],
    ['nachos', 'Loaded nachos', '🌶️', 15, ['crisps', ['cheddar', 'mozzarella']], ['salsa', 'guacamole', 'sourcream', 'beans', 'springonion', 'chilli', 'mince'],
      ['Heat the oven to 200°C / 400°F.', 'Spread tortilla chips on a tray.', 'Scatter with cheese, beans and anything else.', 'Bake 8 minutes; top with salsa, guac and sour cream.']],
  ];
  const RECIPES = R.map((r) => ({
    id: r[0], title: r[1], emoji: r[2], minutes: r[3],
    uses: r[4].map((u) => (Array.isArray(u) ? u : [u])).map((alts) => alts.filter((id) => CAT[id])),
    nice: r[5].filter((id) => CAT[id]),
    steps: r[6],
  }));

  /** How much using this item tonight matters: what is going off counts most. */
  function urgency(item, today) {
    if (item.place === 'freezer') return 0.2;
    const d = daysLeft(item, today);
    if (d < 0) return 2.5;
    if (d === 0) return 5;
    if (d === 1) return 4;
    if (d <= 3) return 3;
    if (d <= 7) return 2;
    return 0.5;
  }
  function altName(alts) {
    const names = alts.slice(0, 2).map((id) => CAT[id].name.toLowerCase());
    return names.join(' or ');
  }
  /** One recipe against the kitchen: which item fills each slot (the most
   *  urgent that fits), what is missing, and how good a use of tonight it is. */
  function matchRecipe(recipe, items, today) {
    const list = sortItems(asList(items));
    const taken = {};
    const used = [];
    const missing = [];
    for (const alts of recipe.uses) {
      const hit = list.find((it) => !taken[it.id] && it.cat && alts.indexOf(it.cat) >= 0);
      if (hit) { taken[hit.id] = 1; used.push(hit); } else missing.push(altName(alts));
    }
    const nice = [];
    for (const id of recipe.nice) {
      const hit = list.find((it) => !taken[it.id] && it.cat === id);
      if (hit) { taken[hit.id] = 1; nice.push(hit); }
    }
    const expiring = used.concat(nice.filter((it) => urgency(it, today) >= 3)).filter((it) => it.place !== 'freezer' && daysLeft(it, today) <= 7);
    let score = 0;
    for (const it of used) score += urgency(it, today);
    for (const it of nice) score += 0.3 * urgency(it, today);
    score -= 2.5 * missing.length;
    return { recipe: recipe, used: used, nice: nice, missing: missing, expiring: expiring, score: Math.round(score * 100) / 100 };
  }
  /** Recipes worth suggesting tonight, best first: each uses something from
   *  the kitchen, needs at most two things more, and (when anything is going
   *  off) uses something that is. */
  function rankRecipes(items, today, recipes) {
    const all = (recipes || RECIPES).map((r) => matchRecipe(r, items, today))
      .filter((m) => m.used.length && m.missing.length <= 2 && m.missing.length < m.recipe.uses.length);
    const anyExpiring = all.some((m) => m.expiring.length);
    return all.filter((m) => !anyExpiring || m.expiring.length)
      .sort((a, b) => b.score - a.score || a.missing.length - b.missing.length || a.recipe.minutes - b.recipe.minutes || (a.recipe.title < b.recipe.title ? -1 : 1));
  }
  /** "Uses 3 things expiring: spinach, eggs and feta · 15 min". */
  function recipeLine(m) {
    const exp = m.expiring;
    const names = exp.map((it) => it.name.toLowerCase());
    const head = exp.length ? 'Uses ' + (exp.length === 1 ? '1 thing' : exp.length + ' things') + ' going off: ' + nameList(names) : 'Uses what you have';
    return head + ' · ' + m.recipe.minutes + ' min';
  }

  /* ------------------------------------------------------------------ *
   * Saved and wasted
   * ------------------------------------------------------------------ */

  /** A day an item counts as rescued: eaten within a day of its date, or after. */
  const RESCUE_DAYS = 1;
  function windowOf(events, today, days) {
    const from = addDays(today, -(days - 1));
    return events.filter((e) => e.date >= from && e.date <= today);
  }
  function tally(events) {
    const t = { ate: 0, binned: 0, rescued: 0, savedUsd: 0, wastedUsd: 0 };
    for (const e of events) {
      if (e.outcome === 'ate') {
        t.ate++;
        if (e.left <= RESCUE_DAYS) { t.rescued++; t.savedUsd += e.price || 0; }
      } else { t.binned++; t.wastedUsd += e.price || 0; }
    }
    t.savedUsd = Math.round(t.savedUsd * 100) / 100;
    t.wastedUsd = Math.round(t.wastedUsd * 100) / 100;
    const all = t.ate + t.binned;
    t.eatenPct = all ? Math.round((t.ate / all) * 100) : null;
    return t;
  }
  /**
   * Everything the Saved tab shows, worked out from the history:
   *   week / month: {ate, binned, rescued, savedUsd, wastedUsd, eatenPct}
   *   weeks: the last four weeks, newest first
   *   streak: {days, best} - days in a row (today included) with nothing
   *     binned, counted from the kitchen's first day
   *   binnedMost: foods binned twice or more in four weeks, with a tip
   */
  function stats(kitchen, today) {
    const events = asList(kitchen.history).filter((e) => isDate(e.date) && e.date <= today);
    const start = isDate(kitchen.created) && kitchen.created <= today ? kitchen.created : (events.reduce((m, e) => (e.date < m ? e.date : m), today));
    const weeks = [];
    for (let i = 0; i < 4; i++) {
      const end = addDays(today, -7 * i);
      const evs = windowOf(events, end, 7);
      weeks.push(Object.assign({ label: i === 0 ? 'This week' : i === 1 ? 'Last week' : i + ' weeks ago', from: addDays(end, -6), to: end }, tally(evs)));
    }
    // The streak: binned days, newest first.
    const binDays = events.filter((e) => e.outcome === 'binned').map((e) => e.date).filter((d, i, a) => a.indexOf(d) === i).sort();
    const last = binDays.length ? binDays[binDays.length - 1] : null;
    const days = last ? daysBetween(last, today) : daysBetween(start, today) + 1;
    let best = days;
    let prev = start;
    for (let i = 0; i < binDays.length; i++) {
      const gap = i === 0 ? daysBetween(prev, binDays[i]) : daysBetween(prev, binDays[i]) - 1;
      if (gap > best) best = gap;
      prev = binDays[i];
    }
    // The most binned, this month.
    const month = windowOf(events, today, 28);
    const by = {};
    for (const e of month) {
      if (e.outcome !== 'binned') continue;
      const key = e.cat || ('n:' + e.name.toLowerCase());
      if (!by[key]) by[key] = { key: key, cat: e.cat, name: e.cat ? CAT[e.cat].name : e.name, emoji: e.emoji, n: 0, usd: 0 };
      by[key].n++; by[key].usd += e.price || 0;
    }
    const binnedMost = Object.keys(by).map((k) => by[k]).filter((x) => x.n >= 2)
      .sort((a, b) => b.n - a.n || b.usd - a.usd || (a.name < b.name ? -1 : 1)).slice(0, 5)
      .map((x) => Object.assign(x, { usd: Math.round(x.usd * 100) / 100, tip: x.cat && CAT[x.cat].tip ? CAT[x.cat].tip : 'buy a little less of it next time' }));
    return { week: weeks[0], month: tally(month), weeks: weeks, streak: { days: Math.max(0, days), best: Math.max(0, best) }, binnedMost: binnedMost, started: start, total: events.length };
  }
  /** "You've binned spinach 3 times this month - buy the small bag?" */
  function binLine(x) {
    return 'You’ve binned ' + x.name.toLowerCase() + ' ' + (x.n === 2 ? 'twice' : x.n + ' times') + ' this month - ' + x.tip + '?';
  }

  /* ------------------------------------------------------------------ *
   * Before you shop
   * ------------------------------------------------------------------ */

  /** dontBuy: what is here and fine (two days or more, not past).
   *  runningOut: what this kitchen eats often (twice in four weeks) and has
   *  none of - or only some that goes today. */
  function shopping(kitchen, today) {
    const items = sortItems(asList(kitchen.items));
    const seen = {};
    const dontBuy = [];
    for (const it of items) {
      if (daysLeft(it, today) < 2 || it.leftover) continue;
      const key = it.cat || it.name.toLowerCase();
      if (seen[key]) { seen[key].qty += it.qty; continue; }
      seen[key] = { key: key, name: it.cat ? CAT[it.cat].name : it.name, emoji: it.emoji, qty: it.qty, until: it.use, place: it.place };
      dontBuy.push(seen[key]);
    }
    dontBuy.sort((a, b) => (a.place === b.place ? (a.name < b.name ? -1 : 1) : PLACE_IDS.indexOf(a.place) - PLACE_IDS.indexOf(b.place)));
    const month = windowOf(asList(kitchen.history).filter((e) => isDate(e.date)), today, 28).filter((e) => e.outcome === 'ate' && e.cat);
    const eaten = {};
    for (const e of month) eaten[e.cat] = (eaten[e.cat] || 0) + 1;
    const runningOut = Object.keys(eaten).filter((c) => eaten[c] >= 2).map((c) => {
      const have = items.filter((it) => it.cat === c);
      const lasting = have.filter((it) => daysLeft(it, today) >= 1);
      if (lasting.length) return null;
      return { key: c, name: CAT[c].name, emoji: CAT[c].emoji, times: eaten[c], why: have.length ? 'the last of it goes today' : 'none left - you had it ' + plural(eaten[c], 'time') + ' this month' };
    }).filter(Boolean).sort((a, b) => b.times - a.times || (a.name < b.name ? -1 : 1)).slice(0, 12);
    return { dontBuy: dontBuy, runningOut: runningOut };
  }
  function shoppingText(s, kitchenName) {
    const lines = [];
    if (s.runningOut.length) lines.push('Running out: ' + s.runningOut.map((x) => x.name.toLowerCase()).join(', '));
    if (s.dontBuy.length) lines.push('Don’t buy - we have: ' + s.dontBuy.map((x) => x.name.toLowerCase() + (x.qty > 1 ? ' ×' + x.qty : '')).join(', '));
    if (!lines.length) lines.push('Nothing to flag - shop as usual.');
    return (kitchenName ? kitchenName + ' - before you shop\n' : '') + lines.join('\n') + '\n(from Shelf Life)';
  }

  return {
    LIMITS, PLACES, PLACE_IDS, BANDS, EMOJI, GROUP, CATALOGUE, CAT, WEEKLY, RECIPES, RESCUE_DAYS,
    clean, cleanText, cleanName, cleanEmoji, cleanFoodEmoji, cleanPlace, cleanQty, cleanTz, cleanItem, cleanEvent, cleanKitchen,
    isItemId, isEventId, isMemberId, isDate, newId, fail, plural, nameList, money, hash32, fold,
    localDate, addDays, daysBetween, dateLabel, relDays,
    catFor, search, shelfDays, priceOf, leftovers,
    daysLeft, bandOf, sortItems, bands, counts, phrase, headline, asList,
    applyPatch, addItems, editItem, open, freeze, thaw, extend, removeItem, done, cook, undo, pruneKeys,
    urgency, matchRecipe, rankRecipes, recipeLine,
    stats, tally, binLine, shopping, shoppingText,
  };
});
