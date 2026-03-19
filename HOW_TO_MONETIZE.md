# How to Monetize Epicenter

Honestly, we're still figuring this out. I've been thinking a lot about the right way to make Epicenter sustainable while staying true to our roots in transparency and open source. I talked it through with contributors, posted about it in [#792](https://github.com/EpicenterHQ/epicenter/issues/792), and went back and forth on a few different models. Here's where I landed.

## Dual licensing

Epicenter is dual-licensed. The entire project is available under AGPL-3.0, making it completely free for anyone building open-source software. If a company wants to incorporate the framework into a closed-source product, they purchase a commercial license to use Epicenter without open-sourcing their changes.

This is the same model Cal.com, dub.sh, Grafana Labs, Bitwarden, and MinIO all use—Redis and MongoDB used it historically, too. The pattern works because AGPL naturally surfaces the companies who need a commercial arrangement. Their compliance tooling flags the license, legal applies their standard ban, and the conversation starts itself. We don't have to chase anyone down.

To me, this feels like an honest trade. The project stays genuinely open for the community, and companies that profit from it help fund its development. If you're building open-source software with Epicenter, it's completely free—no strings, no gotchas. The commercial side is for companies running things behind their firewall without sharing modifications.

## For developers building on Epicenter

Your own code can be under any AGPL-compatible license—MIT, Apache 2.0, BSD, ISC, whatever you prefer. You don't have to use AGPL for your own files. The catch is that the combined work (your code plus our AGPL library) must comply with AGPL when you distribute it or serve it over a network, meaning your users need access to the full source. Grafana works the same way: their UI libraries are Apache 2.0 so plugin developers keep their own license, even though the combined Grafana distribution is AGPL.

## Sustaining the project

The dual license is the foundation, but there are a few other natural ways to keep the lights on. We'll run a hosted sync server for users who just want things to work without managing infrastructure—same idea as Obsidian Sync. Enterprises with strict data sovereignty needs will self-host and buy commercial licenses. And since Epicenter does transcription and AI assistance, users who don't want to manage their own API keys can pay for bundled compute at reasonable rates.

These serve different people with different constraints. Someone paying for hosted sync will never self-host; an enterprise buying a commercial license will never let data leave their network.

## The CLA

Every project using this model requires a CLA—Grafana, Bitwarden, MinIO, AppFlowy, Logseq, all of them. We added one too. It's a lightweight Apache ICLA-style agreement: you grant us a license to include your contributions in both the open-source and commercial versions of Epicenter. It's a license grant, not copyright assignment—you keep your copyright. The full text is in [CLA.md](CLA.md).

I want to double down on supporting developers who are building in the open. The code stays free, the community stays free, and companies building closed-source products on top of our work contribute back financially.
