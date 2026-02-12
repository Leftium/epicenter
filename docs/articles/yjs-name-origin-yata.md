# The Y in Yjs Comes from YATA: "Yet Another Transformation Approach"

> Yjs = YATA + JS. The Y literally stands for YATA: "Yet Another Transformation Approach."

If you've ever used Yjs and wondered what the "Y" stands for, you're not alone. There's no splash page explaining it. No FAQ entry. But the answer is sitting right there in the academic paper that started it all.

## YATA: a self-aware name

Kevin Jahns co-authored YATA while researching collaborative editing at RWTH Aachen University. The name is a nod to the long line of Operational Transformation algorithms that came before it. OT had been the dominant approach to real-time collaboration since the 1980s, with dozens of variations: GOT, GOTO, SOCT, COT, SDT. By the time Jahns published his work, the field had accumulated enough acronyms that calling yours "yet another" one was honest.

The twist is that YATA isn't actually an OT algorithm. It's a CRDT (Conflict-free Replicated Data Type), which takes a fundamentally different approach to conflict resolution. OT transforms operations against each other; CRDTs design data structures where conflicts resolve automatically. The "yet another transformation approach" name is tongue-in-cheek: it acknowledges the lineage while doing something genuinely different.

## The naming pattern across the ecosystem

Once you see the YATA connection, the entire Yjs ecosystem naming scheme clicks into place. Every port follows the same formula: Y + language.

| Library | Language | Name Origin |
|---------|----------|-------------|
| Yjs | JavaScript | Y + js |
| Yrs | Rust | Y + rs |
| Yrb | Ruby | Y + rb |
| Yswift | Swift | Y + swift |
| Ypy | Python | Y + py |

The shared types follow the same convention: `Y.Doc`, `Y.Map`, `Y.Array`, `Y.Text`. The Y prefix is the thread connecting a Rust port to a Python binding to a JavaScript runtime. They all implement the same YATA algorithm underneath.

## Why this isn't documented anywhere

Jahns never wrote a "why I named it Y" blog post. The connection lives in the original 2015 paper, ["Yjs: A Framework for Near Real-Time P2P Shared Editing on Arbitrary Data Types"](https://link.springer.com/chapter/10.1007/978-3-319-19890-3_55), and the follow-up YATA paper, ["Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types"](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types). If you read the papers, the framework and the algorithm are presented together. The naming is obvious in context; it just never got its own explainer.

Most developers discover Yjs through npm, not through academic papers. By the time Yjs hit mainstream adoption, the YATA origin was several layers of documentation removed from the README.

## References

- [Original Yjs paper (SpringerLink, 2015)](https://link.springer.com/chapter/10.1007/978-3-319-19890-3_55)
- [YATA paper (ResearchGate, 2016)](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types)
- [YATA algorithm deep dive (Bartosz Sypytkowski)](https://www.bartoszsypytkowski.com/yata/)
- [Yjs GitHub](https://github.com/yjs/yjs)
- [Kevin Jahns on GitHub](https://github.com/dmonad)
