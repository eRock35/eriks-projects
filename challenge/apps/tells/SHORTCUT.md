# "Check with Tells" - the iPhone share-sheet Shortcut

One Shortcut takes **text, links, Safari pages and pictures** from the share
sheet in any app. Text and links open Tells in Safari with the free quick
scan (nothing that costs credit runs until you tap). A picture is checked
straight away and the answer is shown as a short text.

The picture branch uses your Tells account's credit (a visual read, about
half a cent), so it needs a **device key**: Tells → Settings → Device keys →
Make a key. It is shown once; paste it into step 7 below.

## Build it (Shortcuts app, iOS 17 or later)

1. Open **Shortcuts**, tap **+**. Tap the name at the top and call it
   **Check with Tells**.
2. Tap **ⓘ** (Details) → turn on **Show in Share Sheet** → Done.
3. At the top of the editor, tap **Receive Any input from Share Sheet** and
   tick only **Images**, **Safari web pages**, **Text** and **URLs**. Set
   *If there's no input* to **Stop and Respond**.
4. Add **Get Images from Input** (input: *Shortcut Input*).
5. Add **If** → *Images* → **has any value**.
6. Inside the If (the picture branch), add in order:
   1. **Base64 Encode** → *Images*. (Rename the result "Original": long-press → Rename.)
   2. **Convert Image** → *Images* to **JPEG**, and tap the arrow to turn
      **Preserve Metadata off**.
   3. **Resize Image** → *Converted Image* → width **1024** (height Auto).
   4. **Base64 Encode** → *Resized Image*. (Rename it "Preview".)
7. Still inside the If, add **Get Contents of URL**:
   - URL: `https://challenge.strongtechnicalconsulting.com/tells/api/check/picture?format=text`
   - Tap the arrow: **Method** POST.
   - **Headers**: add `Authorization` with the value `Bearer tells_…` (your
     key, after the word Bearer and a space).
   - **Request Body**: JSON. Add a field `original` of type **Dictionary**
     with one field `data` (Text) = *Original*. Add a field `preview` of type
     **Dictionary** with one field `data` (Text) = *Preview*.
8. Add **Show Result** → *Contents of URL*.
9. Tap **Otherwise** (the text-and-links branch) and add:
   1. **URL Encode** → *Shortcut Input* (Encode).
   2. **Text**: `https://challenge.strongtechnicalconsulting.com/tells/?src=shortcut&q=`
      followed by *URL Encoded Text*.
   3. **Open URLs** → *Text*.
10. Done. In Photos, LinkedIn, X, Safari or anywhere else: **Share →
    Check with Tells**.

## What each branch sends

- **Picture:** the original file, so our server can read its metadata
  (Content Credentials, IPTC source type, generator settings, camera EXIF);
  and a 1024-pixel JPEG copy with the metadata turned off, which is the only
  thing the model sees. Both are read once and dropped; nothing is stored.
  If you leave out the preview, the server cuts the original's EXIF and XMP
  out before the model sees it.
- **Text and links:** nothing is sent by the Shortcut. It opens Tells in
  Safari with the text or link in the address; Tells runs the free quick
  scan there and waits for you. (LinkedIn and X hide posts from servers:
  share the post's *text* rather than its link, or select the text and use
  the bookmark.)

## If it says something went wrong

- `That device key did not work` - make a new key in Settings and paste it
  again; revoked keys stop at once.
- `You have used your credit` - the $2 free allowance is spent; top up on
  the Tells page. The text-and-links branch keeps working (it is free).
- `The original must be a JPEG, PNG, WebP, GIF, HEIC or AVIF picture` - the
  share gave the Shortcut something that is not a picture.
- The original is limited to 8 MB. A 48-megapixel ProRAW or a very large
  PNG can be over; share a screenshot of it instead, or lower the camera's
  resolution.
