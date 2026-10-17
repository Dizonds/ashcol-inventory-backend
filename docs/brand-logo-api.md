# Brand logo API

The brand cards demonstrate consuming an external API through an Express API.
No API key is required.

1. React uses Axios (`api.js`) to request `GET /api/brands/:id/logo` with the existing login token.
2. Express reads the saved brand and calls Wikipedia's summary API to find its Wikidata entity ID.
3. Express calls Wikidata's entity API and reads **P154**, the company logo property.
4. Express returns JSON containing the image URL. React displays it inside the card.

Example response:

```json
{
  "brandId": "the-brand-id",
  "name": "Daikin",
  "logoUrl": "https://upload.wikimedia.org/wikipedia/commons/0/05/DAIKIN_logo.svg",
  "sourceUrl": "https://commons.wikimedia.org/wiki/File:DAIKIN_logo.svg"
}
```

Open the browser developer tools, select **Network**, then click **Show Brands**
to inspect the API requests and JSON responses. Calls to Wikimedia happen on the server.

Successful lookups are cached in server memory for a day. Missing logos and provider
errors are cached briefly. When a logo is unavailable, `logoUrl` and `sourceUrl` are
`null` and the card displays the brand name. Unknown brand IDs return 404; malformed
IDs return 400. Removing a brand still uses `DELETE /api/brands/:id`.

The logo links to its Wikimedia Commons file page, where its source and licensing
information can be inspected. Brand names and logos remain their owners' trademarks.

Provider documentation: [Wikidata data access](https://www.wikidata.org/wiki/Wikidata:Data_access).
