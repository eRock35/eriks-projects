// The contact address is not written in any page. Harvesting bots read HTML
// (and the public repo) for mailto: links and name@domain text, so the
// address is kept here reversed and put together only when someone clicks a
// [data-contact] link. A bot that renders the page still finds no address;
// a person gets their mail app, and the address appears on the page too in
// case they have none set up.
(function () {
  var p = ['moc.gnitlusnoclacinhcetgnorts', 'gnorts.kire'];
  function rev(s) { return s.split('').reverse().join(''); }
  function address() { return rev(p[1]) + String.fromCharCode(64) + rev(p[0]); }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-contact]') : null;
    if (!a) return;
    e.preventDefault();
    var addr = address();
    var show = a.querySelector('[data-contact-show]') || (a.hasAttribute('data-contact-self') ? a : null);
    if (show) {
      // A line may break after the @ (a <wbr>, which copies as nothing).
      var at = addr.indexOf(String.fromCharCode(64)) + 1;
      show.textContent = addr.slice(0, at);
      if (show.appendChild && document.createElement) show.appendChild(document.createElement('wbr'));
      if (show.appendChild && document.createTextNode) show.appendChild(document.createTextNode(addr.slice(at)));
      else show.textContent = addr;
    }
    window.location.href = 'mailto:' + addr;
  });
})();
