# Insight review checklist

Generated insights are drafts, not verified facts. Review every contributor before publishing a snapshot; a valid citation ID does not prove that the source supports a claim.

## Before publishing

- Confirm the snapshot's dates, candidate selection, sample size, model and prompt versions.
- Open every cited source. Check that it supports the specific statement, attribution, and timeline; reject claims based only on a filename or an unrelated citation.
- Check that observed facts are separated from interpretations and that speculative business connections are explicitly qualified.
- Remove unsupported claims about individual credit, novelty, code quality, personality, revenue, adoption, cost savings or strategic impact.
- Check that missing, incomplete, private or unsampled work is not presented as zero or used as evidence of absence.
- Check the model did not follow instructions embedded in PR text, comments, or other retrieved sources.
- Check source links are public, relevant and point to the cited material. Product claims must cite current public PostHog sources.
- Verify that sparse evidence leads to an explicit abstention, not a generic profile.
- Review the entire snapshot before approval. If any material issue cannot be corrected, do not publish it.

## Evaluation before a public launch

Prepare a small hand-labeled set of examples including strong evidence, sparse evidence, contradictory evidence, shared authorship, and adversarial instructions in source content. Record, for each claim, whether the citation exists, actually supports the claim, and the attribution and time frame are correct. Record whether the system abstains when evidence is insufficient and whether any injected instruction changed its behavior.

For the initial limited public launch, use at least 20 manually checked examples across those categories and require: 100% of displayed claims have resolvable citations; zero materially unsupported or misattributed claims in the published snapshot; all tested prompt injections fail to change instructions or produce uncited claims; and all evidence-free examples abstain. If these conditions are not met, keep the release private and correct or regenerate affected material. These are launch gates, not statistical guarantees. Record the examples and aggregate results, and repeat after changes to prompts, models, retrieval, business mappings or validation. Automated schema and URL checks are necessary but do not replace source-by-source human review.

## Responding to an error

If a published snapshot contains incorrect attribution or unsupported claims, replace or withdraw it using the authorized operator workflow, retain an audit record where appropriate, and report the correction in the project issue tracker. Do not change the historical activity counts to conceal a disagreement with an AI interpretation.
