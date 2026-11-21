/* Ladle - the made-up example. Everything here is invented: Nana Dot's
 * recipe box, the family on its cards (Nana Dot, Aunt Lou, Uncle Ray,
 * Grandpa Walt and Mom) and the cards themselves. Thanksgiving is
 * Thursday 26 November 2026, so the example's list is the family dinner.
 * It is never kept, sent or synced. No clock and no dice: the times are
 * constants.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ladle-core'));
  else root.LadleDemo = factory(root.LadleCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var T = 1795251600000;   // 21 Nov 2026, 09:00 UTC - the example's "now"
  var NAME = 'Nana Dot’s recipe box';
  var NOTICE = 'Made up: Nana Dot’s recipe box, the family on its cards and the cards themselves are invented. Nothing here is kept or sent.';

  // [id, title, from, serves, ingredients (as a card writes them), steps, notes]
  var RECIPES = [
    ['rpumpkin1', 'Pumpkin pie', 'Nana Dot', 8,
      ['1 (15 oz) can pumpkin', '3/4 c. sugar', '1 t cinnamon', '1/2 t ground ginger', '1/4 t ground cloves', '1/2 t salt', '2 eggs', '1 (12 oz) can evaporated milk', '1 unbaked 9-inch pie crust'],
      ['Heat the oven to 425°F.', 'Mix the sugar, cinnamon, ginger, cloves and salt in a small bowl.', 'Beat the eggs in a large bowl. Stir in the pumpkin and the sugar mix.', 'Stir in the evaporated milk a little at a time.', 'Pour into the crust and bake 15 minutes.', 'Turn the oven down to 350°F and bake 40-50 minutes, until a knife in the middle comes out clean.', 'Cool on a rack for 2 hours before cutting.'],
      'Nana always made two - one for the table and one for Uncle Ray to take home.'],
    ['rdressing', 'Cornbread dressing', 'Nana Dot', 10,
      ['6 cups crumbled cornbread', '4 cups torn white bread', '1/2 cup butter', '1 1/2 cups chopped onion', '1 cup chopped celery', '2 tsp dried sage', '1 tsp dried thyme', '1/2 tsp black pepper', '1 tsp salt', '3 cups chicken broth', '2 eggs, beaten'],
      ['Heat the oven to 350°F and butter a 9 x 13 inch dish.', 'Melt the butter in a skillet and cook the onion and celery until soft, about 10 minutes.', 'Toss the cornbread, bread, sage, thyme, salt and pepper in a big bowl. Add the onion and celery.', 'Stir in the broth and the eggs until it is moist but not soupy.', 'Spread it in the dish and bake 45 minutes, until golden on top.'],
      'Make the cornbread the day before so it dries out a little.'],
    ['rsweetpot', 'Sweet potato casserole', 'Aunt Lou', 8,
      ['3 cups mashed sweet potatoes', '1/2 cup sugar', '2 eggs', '1/2 cup milk', '1/4 cup butter, melted', '1 tsp vanilla', '1 cup brown sugar', '1/3 cup flour', '1/4 cup butter, soft', '1 cup chopped pecans'],
      ['Heat the oven to 350°F.', 'Beat the sweet potatoes, sugar, eggs, milk, melted butter and vanilla until smooth. Spread in a buttered dish.', 'Rub the brown sugar, flour and soft butter together, then stir in the pecans.', 'Scatter the topping over and bake 30 minutes.'],
      'Lou says the topping is the point. Do not skimp.'],
    ['rcranberr', 'Cranberry sauce with orange', 'Mom', 8,
      ['1 cup sugar', '3/4 cup orange juice', '12 oz fresh cranberries', '1 tsp grated orange zest'],
      ['Bring the sugar and orange juice to a boil, stirring until the sugar is gone.', 'Add the cranberries and simmer 10 minutes, until most of them pop.', 'Stir in the zest. Cool, then chill at least 2 hours.'],
      ''],
    ['rbutterol', 'Butter rolls', 'Grandpa Walt', 24,
      ['1 cup warm milk', '2 1/4 tsp yeast', '1/4 cup sugar', '1/2 cup butter, melted', '1 egg', '1 tsp salt', '4 cups flour'],
      ['Stir the yeast and sugar into the warm milk and let it foam, about 10 minutes.', 'Beat in half the butter, the egg and the salt, then the flour a cup at a time.', 'Knead 8 minutes, until smooth. Cover and let rise 1 hour.', 'Roll out, cut circles, brush with butter and fold in half. Let rise 30 minutes.', 'Bake at 375°F for 15-18 minutes, until golden.'],
      'Walt brushed them with the last of the butter as they came out.'],
    ['rraychili', 'Uncle Ray’s chili', 'Uncle Ray', 6,
      ['2 lb ground beef', '1 large onion, chopped', '3 cloves garlic, minced', '2 T chili powder', '1 t cumin', '1 (28 oz) can crushed tomatoes', '2 (15 oz) cans kidney beans', '1 t salt'],
      ['Brown the beef in a big pot. Pour off the fat.', 'Add the onion and garlic and cook 5 minutes.', 'Stir in the chili powder and cumin for a minute, then the tomatoes, beans and salt.', 'Simmer, lid half on, 1 1/2 hours. Stir now and then.'],
      'For the Friday after - the house always wants something that is not turkey.'],
  ];

  // The list for Thursday: two pumpkin pies, the dressing and the sweet
  // potatoes - 24 lines from three cards, and coffee typed by hand.
  var PLAN = { rpumpkin1: [2, 1], rdressing: [1, 1], rsweetpot: [1, 1] };

  function box() {
    var b = C.newBox(T);
    RECIPES.forEach(function (r) {
      var made = C.recipeFrom({ title: r[1], from: r[2], serves: String(r[3]), ingredients: r[4].join('\n'), steps: r[5].join('\n'), notes: r[6] }, T);
      if (made.errors.length) throw new Error('demo ' + r[0] + ': ' + made.errors[0]);
      b.recipes[r[0]] = made.recipe;
    });
    Object.keys(PLAN).forEach(function (id) { b.shop.plan[id] = { on: true, k: PLAN[id], t: T }; });
    b.shop.extra.xcoffee1 = { text: 'Coffee for the morning', t: T, del: false };
    return b;
  }

  /* ---- "Type it up": a made-up card, and its reading ---- */

  // Aunt Lou's pecan pie, on a lined index card, drawn as SVG.
  function cardSvg() {
    var hand = 'font-family="Segoe Print, Bradley Hand, Comic Sans MS, cursive" fill="#2b3a67"';
    var L = ['Pecan Pie', 'from Lou', '3 eggs', '1 c. sugar', '1 c. dark corn syrup', '2 T butter, melted', '1 t vanilla', '1 1/2 c. pecans', '1 unbaked pie shell', 'Beat eggs, sugar, syrup, butter, vanilla.', 'Stir in nuts. Pour in shell.', 'Bake 350° 50-55 min till set.'];
    var rows = '';
    for (var i = 0; i < 11; i++) rows += '<line x1="18" y1="' + (78 + i * 22) + '" x2="462" y2="' + (78 + i * 22) + '" stroke="#9db7d6" stroke-width="1"/>';
    var txt = L.map(function (t, i) {
      if (i === 0) return '<text x="40" y="46" font-size="26" ' + hand + '>' + C.esc(t) + '</text>';
      if (i === 1) return '<text x="300" y="46" font-size="16" ' + hand + '>' + C.esc(t) + '</text>';
      var col = i < 9 ? 40 : 40, y = 74 + (i - 1) * 22;
      return '<text x="' + col + '" y="' + y + '" font-size="15" ' + hand + '>' + C.esc(t) + '</text>';
    }).join('');
    return '<svg class="cardsvg" viewBox="0 0 480 320" role="img" aria-label="A made-up index card in faded handwriting: Aunt Lou’s pecan pie">' +
      '<rect x="4" y="6" width="472" height="308" rx="6" fill="#f3e9d2" stroke="#c9b48a" stroke-width="2"/>' +
      '<line x1="18" y1="56" x2="462" y2="56" stroke="#d4686a" stroke-width="2"/>' + rows +
      '<circle cx="420" cy="250" r="34" fill="#c9a25c" opacity=".25"/>' + txt + '</svg>';
  }
  // What a model might send back for it - with the extras a real answer
  // can carry, so the example shows the checks: a "from" field (Ladle never
  // asks a model for a name), calories, and a nutrition line in the steps.
  var CARD_RAW = {
    title: 'Pecan Pie',
    serves: 8,
    ingredients: [
      { amount: '3', unit: '', item: 'eggs', unclear: false },
      { amount: '1', unit: 'c.', item: 'sugar', unclear: false },
      { amount: '1', unit: 'c.', item: 'dark corn syrup', unclear: false },
      { amount: '2', unit: 'T', item: 'butter, melted', unclear: false },
      { amount: '1', unit: 't', item: 'vanilla', unclear: true },
      { amount: '1 1/2', unit: 'c.', item: 'pecans', unclear: false },
      { amount: '1', unit: '', item: 'unbaked pie shell', unclear: false },
    ],
    steps: [
      { text: 'Beat eggs, sugar, syrup, butter, vanilla.', unclear: false },
      { text: 'Stir in nuts. Pour in shell.', unclear: false },
      { text: 'Bake 350° 50-55 min till set.', unclear: true },
      { text: 'About 480 calories a slice.', unclear: false },
    ],
    notes: '',
    unsure: ['serves'],
    from: 'Lou',
    calories: 480,
  };

  return { T: T, NAME: NAME, NOTICE: NOTICE, box: box, cardSvg: cardSvg, CARD_RAW: CARD_RAW, PLAN: PLAN };
}));
