/* Ajar - the built-in deck. Plain activities in our own words: no brand,
 * shop, product, film, show, book, song or character is named anywhere in
 * here (test/run.js checks every file for a list of them), and nothing is
 * religious - winter, festive lights and baking, birthdays, trips and "any
 * time" things, so a family that does not celebrate Christmas can count
 * down to anything.
 *
 * Each activity:
 *   id     a stable slug (the AI is sent these ids, never a title a family typed)
 *   t      title
 *   th     theme: festive | winter | any | birthday | trip
 *   tm     time: quick (5 min) | short (30 min) | evening | half (half a day)
 *   c      cost: free | little | some, and $ the default amount (the family can change it)
 *   w      where: home | nearby | outdoors
 *   m      mess: none | some | lots
 *   k      kind (the same chips the AI is offered): crafts, baking, outdoors,
 *          music, building, reading, giving, science, games, quiet
 *   a      ages [min, max]
 *   n      needs: what to buy or find, up to 4 short things
 *   h      how, one line
 *
 * Fillers are the doors for very busy days: an original joke, a tiny treat,
 * or a note to each other. They cost nothing, take a minute and need
 * nothing bought.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AjarDeck = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function A(id, t, th, tm, c, $, w, m, k, a, n, h) {
    return { id: id, t: t, th: th, tm: tm, c: c, $: $, w: w, m: m, k: k, a: a, n: n, h: h };
  }

  var DECK = [
    // ---- winter festive: lights, decorations, baking, giving ----
    A('paper-chain', 'Make a paper chain', 'festive', 'short', 'little', 3, 'home', 'some', 'crafts', [3, 12], ['coloured paper', 'glue stick'], 'Cut strips, loop and glue them, and see whose chain reaches the door first.'),
    A('salt-dough', 'Salt-dough decorations', 'festive', 'evening', 'little', 2, 'home', 'lots', 'crafts', [3, 12], ['plain flour', 'salt', 'ribbon'], 'Mix flour, salt and water, cut out shapes, bake them low and slow, and paint them tomorrow.'),
    A('decorate-biscuits', 'Decorate biscuits', 'festive', 'short', 'little', 5, 'home', 'lots', 'baking', [3, 12], ['plain biscuits', 'icing sugar', 'sprinkles'], 'Mix runny icing, set out the sprinkles and let everyone decorate a plateful to share.'),
    A('lights-walk', 'A walk to see the lights', 'festive', 'short', 'free', 0, 'nearby', 'none', 'outdoors', [2, 17], [], 'Wrap up after dark, walk the streets nearby and vote for the brightest window.'),
    A('wrap-together', 'Wrap presents together', 'festive', 'short', 'little', 4, 'home', 'some', 'giving', [4, 17], ['wrapping paper', 'sticky tape'], 'Put some music on and wrap a few presents - the kids do the tape and the tags.'),
    A('homemade-cards', 'Make cards for people we love', 'festive', 'short', 'little', 3, 'home', 'some', 'crafts', [3, 17], ['folded card', 'felt tips'], 'Draw a picture on the front and write one nice thing inside for each person.'),
    A('biscuit-house', 'Build a biscuit house', 'festive', 'half', 'some', 12, 'home', 'lots', 'baking', [4, 17], ['ginger biscuits', 'icing sugar', 'small sweets'], 'Stick biscuit walls together with thick icing, let it set, then tile the roof with sweets.'),
    A('paper-stars', 'Fold paper stars for the window', 'festive', 'short', 'little', 2, 'home', 'none', 'crafts', [6, 17], ['coloured paper'], 'Fold squares into stars and stick them on the window where the street can see them.'),
    A('winter-playlist', 'Make a family winter playlist', 'festive', 'short', 'free', 0, 'home', 'none', 'music', [2, 17], [], 'Everyone picks two winter songs, then play the lot while you dance round the kitchen.'),
    A('painted-cones', 'Paint pine cones', 'festive', 'short', 'little', 2, 'home', 'some', 'crafts', [3, 12], ['pine cones', 'white paint'], 'Dab the tips of pine cones with white paint so they look frosted, then line them up to dry.'),
    A('orange-garland', 'Dried orange garland', 'festive', 'evening', 'little', 3, 'home', 'some', 'crafts', [5, 17], ['oranges', 'string'], 'Slice oranges thinly, dry them in a low oven for a couple of hours, then thread them up.'),
    A('popcorn-garland', 'Thread a popcorn garland', 'festive', 'short', 'little', 2, 'home', 'some', 'crafts', [6, 17], ['popcorn kernels', 'needle and thread'], 'Pop a bowl of plain popcorn, eat half, and thread the rest into a long garland.'),
    A('decorate-tree', 'Put up the decorations', 'festive', 'evening', 'free', 0, 'home', 'some', 'crafts', [2, 17], [], 'Hang the decorations together - each person tells the story of one of them.'),
    A('window-drawings', 'Draw on the windows', 'festive', 'short', 'little', 4, 'home', 'some', 'crafts', [3, 12], ['window pens'], 'Draw frost, stars or a winter scene on the inside of a window. It wipes off later.'),
    A('shortbread', 'Bake shortbread', 'festive', 'evening', 'little', 4, 'home', 'some', 'baking', [4, 17], ['butter', 'plain flour', 'caster sugar'], 'Rub butter into flour and sugar, press it into a tin, prick it with a fork and bake.'),
    A('lantern-jars', 'Make lantern jars', 'festive', 'short', 'little', 3, 'home', 'some', 'crafts', [4, 12], ['clean jars', 'tissue paper', 'battery tea lights'], 'Glue torn tissue paper round a jar and pop a battery light inside.'),
    A('winter-quiz', 'A winter quiz at dinner', 'festive', 'quick', 'free', 0, 'home', 'none', 'games', [5, 17], [], 'Everyone brings three questions about winter, animals or the family. The loser clears the plates.'),
    A('give-toys', 'Choose toys to pass on', 'festive', 'short', 'free', 0, 'home', 'none', 'giving', [4, 17], [], 'Each person picks something in good condition to pass on to a family who could use it.'),
    A('kindness-bags', 'Pack a warm kindness bag', 'festive', 'short', 'some', 10, 'nearby', 'none', 'giving', [5, 17], ['warm socks', 'snacks', 'small bags'], 'Fill a bag with socks and snacks and take it to a local collection point together.'),
    A('plate-wreath', 'Make a paper-plate wreath', 'festive', 'short', 'little', 2, 'home', 'some', 'crafts', [3, 10], ['paper plates', 'green paper', 'glue stick'], 'Cut the middle out of a plate and cover the ring with torn green paper leaves.'),
    A('jar-snow-globe', 'Make a jar snow globe', 'festive', 'evening', 'little', 5, 'home', 'lots', 'crafts', [6, 17], ['small jars with lids', 'glitter', 'waterproof glue'], 'Glue a small toy to the lid, fill the jar with water and glitter, and screw it on tight.'),
    A('neighbour-cards', 'Post cards through the neighbours’ doors', 'festive', 'short', 'free', 0, 'nearby', 'none', 'giving', [3, 17], [], 'Write a few cards to the neighbours and deliver them on a walk before tea.'),
    A('bake-for-neighbour', 'Bake something for a neighbour', 'festive', 'evening', 'little', 5, 'home', 'some', 'baking', [4, 17], ['self-raising flour', 'sugar', 'a tin to give'], 'Bake a small batch and leave it on a neighbour’s step with a note.'),
    A('print-paper', 'Print your own wrapping paper', 'festive', 'evening', 'little', 4, 'home', 'lots', 'crafts', [3, 12], ['brown paper', 'poster paint', 'potatoes'], 'Cut shapes into potato halves and stamp patterns all over brown paper.'),
    A('fairy-light-story', 'A story by fairy lights', 'festive', 'short', 'free', 0, 'home', 'none', 'reading', [2, 12], [], 'Turn off the big lights, switch on the small ones and read a winter story together.'),
    A('light-fort', 'A fort under fairy lights', 'festive', 'evening', 'free', 0, 'home', 'some', 'building', [3, 12], [], 'Drape blankets over chairs, string lights inside and eat dinner in the fort.'),

    // ---- winter ----
    A('paper-snowflakes', 'Cut paper snowflakes', 'winter', 'short', 'free', 0, 'home', 'some', 'crafts', [5, 17], ['white paper'], 'Fold a square into a triangle three times, snip shapes along the edges, then unfold.'),
    A('bird-feeder', 'Make a bird feeder', 'winter', 'short', 'little', 3, 'outdoors', 'some', 'outdoors', [4, 17], ['pine cones', 'bird seed', 'string'], 'Roll a pine cone in seed, hang it where you can see it from a window, and watch who visits.'),
    A('walk-bingo', 'Winter walk bingo', 'winter', 'short', 'free', 0, 'outdoors', 'none', 'outdoors', [3, 12], [], 'Draw a card of things to spot - a red berry, a bare tree, a bird, a puddle - and go and find them.'),
    A('ice-suncatchers', 'Ice suncatchers', 'winter', 'short', 'free', 0, 'outdoors', 'some', 'science', [3, 12], ['a shallow tray', 'string'], 'Freeze leaves and berries in a tray of water with a loop of string, then hang it on a branch.'),
    A('star-count', 'Count the stars', 'winter', 'short', 'free', 0, 'outdoors', 'none', 'science', [4, 17], [], 'On a clear night, turn off the lights, wrap up warm and count stars from the garden or a window.'),
    A('soup-night', 'Make soup together', 'winter', 'evening', 'little', 5, 'home', 'some', 'baking', [4, 17], ['vegetables', 'stock cubes'], 'Everyone chops something (grown-ups the hard bits), then simmer it all and dunk bread in it.'),
    A('hot-chocolate', 'Hot chocolate night', 'winter', 'short', 'little', 4, 'home', 'some', 'quiet', [2, 17], ['cocoa', 'milk', 'marshmallows'], 'Make mugs of hot chocolate with all the toppings and drink them under a blanket.'),
    A('salt-painting', 'Salt-crystal frost painting', 'winter', 'short', 'little', 1, 'home', 'some', 'science', [3, 12], ['salt', 'dark paper'], 'Paint with very salty water on dark paper and watch frosty crystals appear as it dries.'),
    A('animal-tracks', 'Look for animal tracks', 'winter', 'short', 'free', 0, 'outdoors', 'some', 'outdoors', [4, 12], [], 'In mud, frost or snow, look for footprints and guess who made them.'),
    A('finger-knitting', 'Try finger knitting', 'winter', 'evening', 'little', 4, 'home', 'none', 'crafts', [6, 17], ['chunky yarn'], 'Loop yarn round four fingers and keep going until you have a scarf for a toy.'),
    A('rice-warmers', 'Make hand warmers', 'winter', 'short', 'little', 2, 'home', 'some', 'crafts', [5, 17], ['rice', 'odd socks'], 'Fill a sock with rice and knot it. A grown-up warms it for a few seconds before bed.'),
    A('puddle-stomp', 'Puddle and leaf stomp', 'winter', 'short', 'free', 0, 'outdoors', 'lots', 'outdoors', [2, 8], [], 'Boots on, coats on, and find the biggest puddles and leaf piles on the street.'),
    A('frost-hunt', 'Frost hunt before breakfast', 'winter', 'quick', 'free', 0, 'outdoors', 'none', 'science', [3, 12], [], 'On a cold morning, find three things covered in frost and look closely at the patterns.'),
    A('stick-den', 'Build a stick den', 'winter', 'half', 'free', 0, 'outdoors', 'some', 'building', [5, 17], [], 'Gather fallen sticks in a wood or park and build a little den big enough to sit in.'),
    A('paper-lanterns', 'Fold paper lanterns', 'winter', 'short', 'little', 2, 'home', 'some', 'crafts', [4, 12], ['coloured paper', 'glue stick'], 'Fold paper in half, snip slits along the fold, then roll it into a lantern and hang it up.'),
    A('moon-diary', 'Draw the moon each night', 'winter', 'quick', 'free', 0, 'home', 'none', 'science', [4, 12], ['a notebook'], 'Look out at the same time each night and draw the moon’s shape. Watch it change.'),
    A('winter-tea-party', 'A warm tea party', 'winter', 'short', 'little', 3, 'home', 'some', 'quiet', [2, 10], ['crumpets', 'jam'], 'Lay a tablecloth on the floor, warm some crumpets and pour pretend tea for the toys.'),
    A('sledge-day', 'Snow day out', 'winter', 'half', 'free', 0, 'outdoors', 'some', 'outdoors', [3, 17], [], 'If it snows, go sledging on a gentle hill; if not, a frosty walk and a race home.'),
    A('cosy-reading', 'Blanket reading hour', 'winter', 'short', 'free', 0, 'home', 'none', 'reading', [2, 17], [], 'Everyone gets a blanket and a book. Grown-ups read too - no phones.'),

    // ---- any time ----
    A('board-games', 'Board game night', 'any', 'evening', 'free', 0, 'home', 'none', 'games', [4, 17], [], 'Each person chooses one game from the cupboard. The winner picks tomorrow’s pudding.'),
    A('jigsaw', 'Start a family jigsaw', 'any', 'short', 'free', 0, 'home', 'none', 'quiet', [4, 17], ['a jigsaw'], 'Tip out the pieces, find the edges together and leave it out to finish over the week.'),
    A('kitchen-disco', 'Kitchen dance party', 'any', 'quick', 'free', 0, 'home', 'none', 'music', [2, 17], [], 'Three songs, lights low, everyone dances. Then straight to bed.'),
    A('own-pizzas', 'Make your own pizzas', 'any', 'evening', 'little', 6, 'home', 'lots', 'baking', [3, 17], ['pizza bases', 'tomato sauce', 'grated cheese'], 'Everyone tops their own base, then swap a slice with someone else.'),
    A('film-night', 'Watch a film together', 'any', 'evening', 'free', 0, 'home', 'none', 'quiet', [2, 17], ['popcorn kernels'], 'Pick a film everyone can enjoy, make popcorn and all sit on the floor.'),
    A('clue-hunt', 'A treasure hunt with clues', 'any', 'short', 'free', 0, 'home', 'none', 'games', [4, 12], [], 'A grown-up hides little rhyming clues around the house that lead to a small surprise.'),
    A('shadow-puppets', 'Shadow puppet show', 'any', 'short', 'little', 2, 'home', 'none', 'crafts', [4, 12], ['card', 'lolly sticks', 'a torch'], 'Cut shapes from card, tape them to sticks and put on a show against the wall with a torch.'),
    A('torch-stories', 'Stories by torchlight', 'any', 'quick', 'free', 0, 'home', 'none', 'reading', [3, 12], ['a torch'], 'Under the covers with a torch, read one short story or make one up.'),
    A('talent-show', 'Family talent show', 'any', 'short', 'free', 0, 'home', 'none', 'music', [3, 17], [], 'Everyone does one act - a song, a joke, a cartwheel - and everyone else claps loudly.'),
    A('playdough', 'Make playdough', 'any', 'short', 'little', 2, 'home', 'lots', 'crafts', [2, 8], ['plain flour', 'salt', 'food colouring'], 'Mix flour, salt, water and a little oil, knead in the colour and make a small zoo.'),
    A('paper-planes', 'Paper plane contest', 'any', 'short', 'free', 0, 'home', 'none', 'building', [4, 17], [], 'Fold one plane each, then fly them down the hall. Furthest, loopiest and best crash win.'),
    A('marble-run', 'Build a marble run', 'any', 'evening', 'free', 0, 'home', 'some', 'building', [5, 17], ['cardboard tubes', 'masking tape', 'marbles'], 'Tape tubes to a wall or a box so a marble can roll the longest way down.'),
    A('fizz-volcano', 'Fizzing volcano', 'any', 'short', 'little', 2, 'home', 'lots', 'science', [3, 12], ['bicarbonate of soda', 'vinegar', 'food colouring'], 'Stand a cup in a tray, add soda and colour, then pour in vinegar and stand back.'),
    A('salt-crystals', 'Grow salt crystals', 'any', 'short', 'little', 1, 'home', 'some', 'science', [5, 17], ['salt', 'string', 'a clean jar'], 'Stir lots of salt into warm water, hang a string in the jar and check it every day.'),
    A('draw-each-other', 'Draw each other', 'any', 'short', 'free', 0, 'home', 'none', 'crafts', [3, 17], [], 'Sit opposite each other and draw a portrait in five minutes - no peeking at the paper allowed.'),
    A('time-capsule', 'Make a time capsule', 'any', 'short', 'free', 0, 'home', 'none', 'quiet', [4, 17], ['a box or tin'], 'Fill a tin with a drawing, a list of favourites and a note to open in a year.'),
    A('box-town', 'Cardboard box town', 'any', 'half', 'free', 0, 'home', 'some', 'building', [3, 12], ['big boxes', 'masking tape'], 'Turn big boxes into houses, a shop and a tunnel, and draw roads on paper between them.'),
    A('sing-along', 'Sing-along night', 'any', 'short', 'free', 0, 'home', 'none', 'music', [3, 17], [], 'Take turns choosing songs everyone knows and sing them with hairbrush microphones.'),
    A('bake-bread', 'Bake a loaf of bread', 'any', 'half', 'little', 3, 'home', 'some', 'baking', [5, 17], ['strong flour', 'dried yeast'], 'Mix, knead, wait for it to rise, shape it and bake - then eat it warm with butter.'),
    A('sock-puppets', 'Sock puppets', 'any', 'short', 'little', 2, 'home', 'some', 'crafts', [4, 12], ['odd socks', 'buttons', 'craft glue'], 'Glue on eyes and hair, then give each puppet a name and a funny voice.'),
    A('paper-animals', 'Fold paper animals', 'any', 'short', 'free', 0, 'home', 'none', 'crafts', [6, 17], ['square paper'], 'Fold a simple fox, dog or frog from a square of paper, then make it a family.'),
    A('library-visit', 'A trip to the library', 'any', 'evening', 'free', 0, 'nearby', 'none', 'reading', [2, 17], [], 'Choose a book each, and one to read together at bedtime.'),
    A('park-adventure', 'A park adventure', 'any', 'half', 'free', 0, 'outdoors', 'some', 'outdoors', [2, 17], ['a flask', 'snacks'], 'Pack a flask and snacks and spend the morning in the biggest park you can get to.'),
    A('obstacle-course', 'Living-room obstacle course', 'any', 'short', 'free', 0, 'home', 'some', 'games', [3, 12], [], 'Cushions to hop, a chair to crawl under, a line to balance on - time each other.'),
    A('call-someone', 'Call someone you miss', 'any', 'quick', 'free', 0, 'home', 'none', 'giving', [2, 17], [], 'Ring or video-call a grandparent, cousin or friend and tell them one good thing from today.'),
    A('breakfast-dinner', 'Breakfast for dinner', 'any', 'short', 'little', 4, 'home', 'some', 'baking', [2, 17], ['eggs', 'bread'], 'Toast, eggs and fruit for tea - in pyjamas, of course.'),
    A('thank-you-notes', 'Thank-you notes', 'any', 'short', 'free', 0, 'home', 'none', 'giving', [4, 17], [], 'Write or draw a thank-you for someone who helps - a teacher, a driver, a neighbour.'),
    A('pancake-faces', 'Pancake faces', 'any', 'short', 'little', 3, 'home', 'some', 'baking', [3, 12], ['pancake mix', 'berries'], 'Make small pancakes and give each one a face out of fruit.'),
    A('charades', 'Charades', 'any', 'quick', 'free', 0, 'home', 'none', 'games', [4, 17], [], 'Act out an animal, a job or a thing you do every day without a word.'),
    A('family-tree', 'Draw our family tree', 'any', 'short', 'free', 0, 'home', 'none', 'quiet', [4, 17], [], 'Draw a big tree with everyone in the family on a branch, and a fact about each.'),
    A('giant-bubbles', 'Giant bubbles', 'any', 'short', 'little', 2, 'outdoors', 'some', 'science', [2, 12], ['washing-up liquid', 'straws', 'string'], 'Thread string through two straws, dip it in soapy water and pull out a huge bubble.'),
    A('pyjama-evening', 'A cosy pyjama evening', 'any', 'short', 'free', 0, 'home', 'none', 'quiet', [2, 17], [], 'Pyjamas straight after tea, all the cushions on the floor, and a slow evening together.'),
    A('memory-jar', 'Fill a memory jar', 'any', 'quick', 'free', 0, 'home', 'none', 'quiet', [3, 17], ['a clean jar'], 'Each person writes or draws the best bit of the year on a slip and drops it in.'),
    A('build-challenge', 'Building challenge', 'any', 'short', 'free', 0, 'home', 'none', 'building', [4, 17], [], 'Set a challenge - the tallest tower, a bridge, a boat - with whatever blocks or bricks you have.'),
    A('freeze-dance', 'Freeze dance', 'any', 'quick', 'free', 0, 'home', 'none', 'music', [2, 10], [], 'Dance while the music plays and freeze like a statue when it stops.'),
    A('homemade-band', 'Make instruments', 'any', 'short', 'free', 0, 'home', 'some', 'music', [3, 10], ['rice', 'empty tubs', 'rubber bands'], 'Shakers from rice in a tub, a guitar from bands on a box - then play together.'),
    A('nature-collage', 'Nature collage', 'any', 'short', 'free', 0, 'outdoors', 'some', 'crafts', [3, 12], ['card', 'craft glue'], 'Collect leaves, twigs and seed heads on a walk and glue them into a picture.'),
    A('cook-dinner', 'Kids plan and cook dinner', 'any', 'evening', 'little', 8, 'home', 'some', 'baking', [6, 17], ['whatever the menu needs'], 'The kids choose the menu (within reason) and do the stirring; grown-ups do the hot bits.'),
    A('story-chain', 'Make up a story together', 'any', 'quick', 'free', 0, 'home', 'none', 'reading', [4, 17], [], 'Each person adds one sentence at a time. Write it down and read it back at the end.'),
    A('comic-strip', 'Draw a comic strip', 'any', 'short', 'free', 0, 'home', 'none', 'crafts', [5, 17], [], 'Fold paper into six boxes and draw a short story about the family pet or a made-up one.'),
    A('bottle-bowling', 'Bottle bowling', 'any', 'short', 'free', 0, 'home', 'none', 'games', [3, 10], ['empty bottles', 'a soft ball'], 'Line up ten empty bottles in the hall and take turns rolling a soft ball at them.'),
    A('ice-rescue', 'Rescue toys from ice', 'any', 'short', 'free', 0, 'home', 'lots', 'science', [3, 8], ['a tub'], 'Freeze small toys in a tub of water overnight, then free them with warm water and spoons.'),
    A('secret-good-deed', 'A secret good deed', 'any', 'quick', 'free', 0, 'home', 'none', 'giving', [3, 17], [], 'Do something kind for someone in the house without being caught. Guess at bedtime.'),
    A('compliment-circle', 'Compliment circle', 'any', 'quick', 'free', 0, 'home', 'none', 'quiet', [3, 17], [], 'At dinner, everyone says one thing they like about the person on their left.'),

    // ---- birthdays ----
    A('birthday-banner', 'Make a birthday banner', 'birthday', 'short', 'little', 3, 'home', 'some', 'crafts', [3, 12], ['card', 'string', 'felt tips'], 'One big letter on each card, then string them up where the birthday person will see them.'),
    A('birthday-interview', 'Birthday interview', 'birthday', 'quick', 'free', 0, 'home', 'none', 'quiet', [3, 17], [], 'Ask the birthday person ten questions - favourite food, best day - and keep the answers for next year.'),
    A('paper-crown', 'Make a paper crown', 'birthday', 'short', 'little', 2, 'home', 'some', 'crafts', [3, 10], ['gold card', 'sticky tape'], 'Cut zigzags along a strip of card, decorate it and fit it round the birthday head.'),
    A('balloon-games', 'Balloon games', 'birthday', 'short', 'little', 3, 'home', 'none', 'games', [4, 12], ['balloons'], 'Keep a balloon off the floor as long as you can, then race them across the room.'),
    A('photo-wall', 'A photo wall of the year', 'birthday', 'short', 'little', 5, 'home', 'some', 'crafts', [4, 17], ['printed photos', 'paper tape'], 'Stick up a photo from each month of the past year and remember what happened.'),
    A('breakfast-plan', 'Plan the birthday breakfast', 'birthday', 'quick', 'free', 0, 'home', 'none', 'baking', [3, 17], [], 'The birthday person chooses the breakfast menu. Write it down so nobody forgets.'),
    A('dream-cake', 'Draw the dream cake', 'birthday', 'quick', 'free', 0, 'home', 'none', 'crafts', [3, 12], [], 'Draw the most amazing cake you can imagine. Nothing is too silly.'),
    A('wish-jar', 'Birthday wishes in a jar', 'birthday', 'quick', 'free', 0, 'home', 'none', 'giving', [3, 17], ['a clean jar'], 'Everyone writes a wish for the birthday person on a slip, to open on the day.'),

    // ---- trips ----
    A('packing-list', 'Make the packing list together', 'trip', 'short', 'free', 0, 'home', 'none', 'quiet', [4, 17], [], 'Each person lists what they will pack, then the grown-ups add the boring things.'),
    A('route-map', 'Draw the route on a map', 'trip', 'short', 'free', 0, 'home', 'none', 'reading', [5, 17], ['a map or a printout'], 'Find where you are and where you are going, and draw the way with a felt tip.'),
    A('five-words', 'Learn five new words', 'trip', 'quick', 'free', 0, 'home', 'none', 'reading', [4, 17], [], 'If you are going somewhere with another language, learn hello, please, thank you and two more.'),
    A('travel-journal', 'Make a travel journal', 'trip', 'short', 'little', 3, 'home', 'some', 'crafts', [4, 17], ['a notebook', 'stickers'], 'Decorate the cover and leave a page for each day you will be away.'),
    A('taste-the-trip', 'Try a food from where you are going', 'trip', 'evening', 'little', 8, 'home', 'some', 'baking', [3, 17], ['ingredients for one dish'], 'Look up one dish from where you are going and make it together.'),
    A('game-bag', 'Pack a travel game bag', 'trip', 'short', 'free', 0, 'home', 'none', 'games', [3, 17], [], 'Fill a small bag with cards, a pencil and paper games for the journey.'),
    A('one-thing-to-see', 'Find one thing to see', 'trip', 'short', 'free', 0, 'home', 'none', 'reading', [5, 17], [], 'Each person finds one place or thing they want to see on the trip and tells everyone why.'),
  ];

  // Original jokes for the busiest evenings - a minute at the door.
  var JOKES = [
    ['Why was the calendar so calm?', 'It took things one day at a time.'],
    ['What did one door say to the other?', 'Let’s hinge out sometime.'],
    ['Why did the mitten stay home from the party?', 'It couldn’t find its other half.'],
    ['What do you call a penguin who can’t stop dancing?', 'A flipper flopper.'],
    ['Why did the bread go to the party?', 'It wanted to loaf about.'],
    ['What is a squirrel’s favourite month?', 'Nut-cember.'],
    ['Why did the broom win the race?', 'It swept past everyone.'],
    ['What do you call a dog in a scarf?', 'A chilly dog.'],
    ['Why don’t biscuits get lonely?', 'They always come in packs.'],
    ['Why is the fridge so good at secrets?', 'It keeps everything cool.'],
    ['What does a bear wear to bed?', 'Paw-jamas.'],
    ['Why did the paper chain win a prize?', 'It was linked to success.'],
    ['What is a snowflake’s favourite dance?', 'The flurry shuffle.'],
    ['Why did the tortoise bring a ladder to the shop?', 'It heard prices were going up.'],
    ['What do you call a sheep in a woolly hat?', 'Twice as warm.'],
    ['Why did the clock get a gold star?', 'It was always on time.'],
    ['What did the glove say to the hand?', 'I’ve got you covered.'],
    ['Why did the pencil stay up late?', 'It wanted to draw the stars.'],
    ['What does a frog read at bedtime?', 'A ribbiting story.'],
    ['Why did the blanket go to school?', 'To learn how to fold.'],
    ['Why was the snowflake so calm?', 'It knew it was one of a kind.'],
    ['What did the button say to the coat?', 'Hold on, we’re nearly done up.'],
    ['What did the teapot say to the kettle?', 'You’re really hot stuff.'],
    ['Why did the robot go on holiday?', 'It needed to recharge.'],
    ['Why did the jigsaw piece look worried?', 'It felt a bit out of place.'],
    ['What do you call a hedgehog in a hat?', 'A prickle with a tickle.'],
    ['Why did the scarf go to bed early?', 'It was all wound up.'],
    ['What is an owl’s favourite subject?', 'Owl-gebra.'],
    ['Why did the cushion get a medal?', 'It always supported the team.'],
    ['What do you call a cat that loves to bake?', 'A whisker.'],
    ['Why did the candle feel proud?', 'Everyone said it was very bright.'],
    ['What do you call a lazy kangaroo?', 'A pouch potato.'],
  ];

  var TREATS = [
    'An extra bedtime story, chosen by you.',
    'Breakfast picnic on the living-room floor.',
    'You choose tomorrow’s pudding.',
    'Ten extra minutes before bed.',
    'A bubble bath with all the bubbles.',
    'Warm milk in the special mug.',
    'You pick the music on the next drive.',
    'Pyjamas straight after school.',
  ];

  var NOTES = [
    'Write a tiny note for someone and hide it in their coat pocket.',
    'Leave a drawing on someone’s pillow for bedtime.',
    'At dinner, say one thing you love about each person.',
    'Stick a smiley note on every bedroom door.',
    'Write a secret compliment and tuck it in someone’s bag.',
    'Draw a picture of something you did together this week and hang it up.',
  ];

  return { DECK: DECK, JOKES: JOKES, TREATS: TREATS, NOTES: NOTES };
}));
