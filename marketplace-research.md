# StellaNova marketplace behavior references

OpenSea’s official support materials describe collection offers as one-time offers that can be accepted by a matching NFT owner, after which the offer expires for the other NFTs in the collection. This supports StellaNova’s need for escrowed offers and an explicit accept/cancel lifecycle. [1]

OpenSea’s buying and selling materials describe selling as a wallet-authorized listing or offer flow, and its current notification help documents user-controlled live alerts and email notifications. StellaNova should therefore separate immutable on-chain settlement events from user notification preferences. [2] [3]

StellaNova’s current Soroban marketplace already has fixed-price listings, cancellations, purchases, escrowed offers, offer cancellation and offer acceptance. It does not yet have auctions, royalty routing, indexed ownership or authenticated server notifications. Those are required before claiming full end-to-end production behavior.

[1]: https://support.opensea.io/en/articles/8866980-what-is-a-collection-offer "OpenSea collection offers"
[2]: https://support.opensea.io/en/collections/8079233-buying-selling-nfts "OpenSea buying and selling NFTs"
[3]: https://support.opensea.io/en/articles/8866965-how-do-i-manage-my-notifications "OpenSea notification management"
