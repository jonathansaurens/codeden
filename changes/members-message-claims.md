---
section: security
---

- **A message can't claim to come from the orchestrator.** On a shared server, an Operator could send a PM a message that claimed to speak for an Owner's orchestrator, with an `ask_pm` marker in its text: the PM's reply was then posted to that Owner's orchestrator and woke it for a turn acting as the Owner. Messages from people and connected agents now keep only their text and attachments (who wrote them, whom they speak for and what they relay are CodeDen's to record), and a PM's reply answers only an `ask_pm` question CodeDen recorded and delivered itself, going back to the orchestrator that asked and nowhere else.
