# NovaMarket marketplace behavior references

OpenSea’s official support materials describe collection offers as one-time offers that can be accepted by a matching NFT owner, after which the offer expires for the other NFTs in the collection. This supports NovaMarket’s need for escrowed offers and an explicit accept/cancel lifecycle. [1]

OpenSea’s buying and selling materials describe selling as a wallet-authorized listing or offer flow, and its current notification help documents user-controlled live alerts and email notifications. NovaMarket should therefore separate immutable on-chain settlement events from user notification preferences. [2] [3]

NovaMarket's current Testnet app supports fixed-price listings, cancellations, purchases, escrowed offers, offer cancellation/acceptance, auctions, indexed ownership, and authenticated in-app notifications. The product owner confirms the marketplace journeys work in the running app. The remaining royalty limitation is architectural: the contract uses a configured royalty recipient/rate rather than automatic per-creator routing. Automated Express/PostgreSQL end-to-end regression coverage is also not yet in CI; that is a testing gap, not evidence that the live journeys fail.

[1]: https://support.opensea.io/en/articles/8866980-what-is-a-collection-offer "OpenSea collection offers"
[2]: https://support.opensea.io/en/collections/8079233-buying-selling-nfts "OpenSea buying and selling NFTs"
[3]: https://support.opensea.io/en/articles/8866965-how-do-i-manage-my-notifications "OpenSea notification management"
