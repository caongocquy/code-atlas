# Retrieval Evaluation Candidate Baseline

- Dataset: retrieval-eval-v2 (73b671896b5dd6f06b6ec97eae479dd87d7269f82e5c8e2fb73413c255fc4fc1)
- CodeAtlas revision: c5c5bf226e13084a9eebfc0df8259ce4b3a6d0a3 (working tree dirty)
- Fixture families: catalog, dispatch, dynamic-registry, pricing, workflow
- Retrieval options: topK 20, rerankTopK 5, RRF k 60, graph depth 2, graph max nodes 8, token budget 4000
- Determinism: PASS (two identical-input runs)

## Aggregate by retrieval stage

| Stage | MRR@5 | Recall@5 | Recall@10 | Hit@1 | Judged coverage @5 | Judged coverage @10 | Unjudged @5 | Unjudged @10 | Duplicate rate | Noise rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphLookup | 0.184 | 0.073 | 0.073 | 0.184 | 0.200 | 0.200 | 2 | 2 | 0.000 | 0.050 |
| lexical | 0.626 | 0.599 | 0.889 | 0.447 | 0.965 | 0.933 | 2 | 16 | 0.050 | 0.350 |
| semantic | 0.184 | 0.092 | 0.092 | 0.184 | 0.175 | 0.175 | 0 | 0 | 0.000 | 0.013 |
| hybrid | 0.659 | 0.626 | 0.921 | 0.474 | 0.990 | 0.960 | 2 | 15 | 0.082 | 0.347 |
| hybridGraphExpansion | 0.659 | 0.626 | 0.921 | 0.474 | 0.965 | 0.914 | 7 | 31 | 0.090 | 0.346 |
| taskContext | 0.072 | 0.102 | 0.102 | 0.026 | 0.083 | 0.083 | 103 | 103 | 0.000 | 0.008 |

## Development vs held-out

| Split | Stage | MRR@5 | Recall@5 | Recall@10 | Hit@1 | Judged coverage @5 | Judged coverage @10 | Unjudged @5 | Unjudged @10 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| development | hybrid::hybrid | 0.910 | 0.800 | 0.912 | 0.846 | 0.971 | 0.980 | 2 | 2 |
| development | hybrid::hybridGraphExpansion | 0.910 | 0.800 | 0.912 | 0.846 | 0.943 | 0.911 | 4 | 9 |
| development | hybrid::lexical | 0.910 | 0.770 | 0.881 | 0.846 | 0.971 | 0.980 | 2 | 2 |
| development | hybrid::semantic | 0.231 | 0.085 | 0.085 | 0.231 | 0.214 | 0.214 | 0 | 0 |
| held-out | hybrid::hybrid | 0.528 | 0.536 | 0.925 | 0.280 | 1.000 | 0.950 | 0 | 13 |
| held-out | hybrid::hybridGraphExpansion | 0.528 | 0.536 | 0.925 | 0.280 | 0.977 | 0.915 | 3 | 22 |
| held-out | hybrid::lexical | 0.478 | 0.511 | 0.893 | 0.240 | 0.962 | 0.908 | 0 | 14 |
| held-out | hybrid::semantic | 0.160 | 0.096 | 0.096 | 0.160 | 0.154 | 0.154 | 0 | 0 |

## Hybrid aggregate by query class

| Group | Stage | MRR@5 | Recall@5 | Recall@10 | Hit@1 | Judged coverage @5 | Judged coverage @10 | Unjudged @5 | Unjudged @10 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ambiguous::hybrid | hybrid | 0.500 | 0.667 | 1.000 | 0.333 | 1.000 | 0.960 | 0 | 2 |
| ambiguous::hybridGraphExpansion | hybrid | 0.500 | 0.667 | 1.000 | 0.333 | 1.000 | 0.960 | 0 | 2 |
| ambiguous::lexical | hybrid | 0.500 | 0.667 | 1.000 | 0.333 | 1.000 | 0.960 | 0 | 2 |
| ambiguous::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| callee::hybrid | hybrid | 0.344 | 0.483 | 0.933 | 0.000 | 1.000 | 0.967 | 0 | 1 |
| callee::hybridGraphExpansion | hybrid | 0.344 | 0.483 | 0.933 | 0.000 | 1.000 | 0.967 | 0 | 1 |
| callee::lexical | hybrid | 0.344 | 0.483 | 0.933 | 0.000 | 1.000 | 0.967 | 0 | 1 |
| callee::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| caller::hybrid | hybrid | 0.675 | 0.688 | 1.000 | 0.500 | 0.950 | 0.939 | 1 | 2 |
| caller::hybridGraphExpansion | hybrid | 0.675 | 0.688 | 1.000 | 0.500 | 0.950 | 0.939 | 1 | 2 |
| caller::lexical | hybrid | 0.675 | 0.688 | 1.000 | 0.500 | 0.950 | 0.939 | 1 | 2 |
| caller::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| cross-file::hybrid | hybrid | 0.567 | 0.511 | 0.933 | 0.333 | 1.000 | 0.967 | 0 | 1 |
| cross-file::hybridGraphExpansion | hybrid | 0.567 | 0.511 | 0.933 | 0.333 | 1.000 | 0.967 | 0 | 1 |
| cross-file::lexical | hybrid | 0.567 | 0.511 | 0.933 | 0.333 | 1.000 | 0.967 | 0 | 1 |
| cross-file::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| exact-symbol::hybrid | hybrid | 0.400 | 0.233 | 0.767 | 0.333 | 1.000 | 0.933 | 0 | 2 |
| exact-symbol::hybridGraphExpansion | hybrid | 0.400 | 0.233 | 0.767 | 0.333 | 1.000 | 0.933 | 0 | 2 |
| exact-symbol::lexical | hybrid | 0.400 | 0.233 | 0.767 | 0.333 | 1.000 | 0.933 | 0 | 2 |
| exact-symbol::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| graph-dependent::hybrid | hybrid | 0.567 | 0.424 | 0.719 | 0.333 | 0.933 | 0.919 | 1 | 2 |
| graph-dependent::hybridGraphExpansion | hybrid | 0.567 | 0.424 | 0.719 | 0.333 | 0.933 | 0.919 | 1 | 2 |
| graph-dependent::lexical | hybrid | 0.567 | 0.424 | 0.719 | 0.333 | 0.933 | 0.919 | 1 | 2 |
| graph-dependent::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| implementation-discovery::hybrid | hybrid | 0.567 | 0.511 | 0.933 | 0.333 | 1.000 | 0.967 | 0 | 1 |
| implementation-discovery::hybridGraphExpansion | hybrid | 0.567 | 0.511 | 0.933 | 0.333 | 1.000 | 0.967 | 0 | 1 |
| implementation-discovery::lexical | hybrid | 0.567 | 0.511 | 0.933 | 0.333 | 1.000 | 0.967 | 0 | 1 |
| implementation-discovery::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| lexical-only::hybrid | hybrid | 0.833 | 0.778 | 1.000 | 0.667 | 1.000 | 0.933 | 0 | 2 |
| lexical-only::hybridGraphExpansion | hybrid | 0.833 | 0.778 | 1.000 | 0.667 | 1.000 | 0.933 | 0 | 2 |
| lexical-only::lexical | hybrid | 0.833 | 0.778 | 1.000 | 0.667 | 1.000 | 0.933 | 0 | 2 |
| lexical-only::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| natural-language::hybrid | hybrid | 0.875 | 0.958 | 1.000 | 0.750 | 1.000 | 1.000 | 0 | 0 |
| natural-language::hybridGraphExpansion | hybrid | 0.875 | 0.958 | 1.000 | 0.750 | 1.000 | 1.000 | 0 | 0 |
| natural-language::lexical | hybrid | 0.875 | 0.958 | 1.000 | 0.750 | 1.000 | 1.000 | 0 | 0 |
| natural-language::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| scip-improved-cross-file::hybrid | hybrid | 0.750 | 0.750 | 1.000 | 0.500 | 1.000 | 1.000 | 0 | 0 |
| scip-improved-cross-file::hybridGraphExpansion | hybrid | 0.750 | 0.750 | 1.000 | 0.500 | 1.000 | 1.000 | 0 | 0 |
| scip-improved-cross-file::lexical | hybrid | 0.750 | 0.750 | 1.000 | 0.500 | 1.000 | 1.000 | 0 | 0 |
| scip-improved-cross-file::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| semantic-disabled::hybrid | hybrid | 0.750 | 0.625 | 0.875 | 0.500 | 1.000 | 1.000 | 0 | 0 |
| semantic-disabled::hybridGraphExpansion | hybrid | 0.750 | 0.625 | 0.875 | 0.500 | 0.900 | 0.833 | 1 | 2 |
| semantic-disabled::lexical | hybrid | 0.625 | 0.625 | 0.875 | 0.500 | 1.000 | 0.950 | 0 | 1 |
| semantic-disabled::semantic | hybrid | 1.000 | 0.375 | 0.375 | 1.000 | 1.000 | 1.000 | 0 | 0 |
| semantic-paraphrase::hybrid | hybrid | 1.000 | 0.833 | 0.944 | 1.000 | 1.000 | 1.000 | 0 | 0 |
| semantic-paraphrase::hybridGraphExpansion | hybrid | 1.000 | 0.833 | 0.944 | 1.000 | 0.800 | 0.600 | 3 | 12 |
| semantic-paraphrase::lexical | hybrid | 0.667 | 0.422 | 0.478 | 0.667 | 0.667 | 0.667 | 0 | 0 |
| semantic-paraphrase::semantic | hybrid | 1.000 | 0.700 | 0.700 | 1.000 | 1.000 | 1.000 | 0 | 0 |
| semantic-unavailable::hybrid | hybrid | 0.750 | 0.575 | 0.775 | 0.500 | 1.000 | 0.900 | 0 | 2 |
| semantic-unavailable::hybridGraphExpansion | hybrid | 0.750 | 0.575 | 0.775 | 0.500 | 0.900 | 0.733 | 1 | 4 |
| semantic-unavailable::lexical | hybrid | 0.750 | 0.675 | 0.875 | 0.500 | 1.000 | 0.900 | 0 | 2 |
| semantic-unavailable::semantic | hybrid | 1.000 | 0.325 | 0.325 | 1.000 | 1.000 | 1.000 | 0 | 0 |

## Hybrid aggregate by fixture family

| Group | Stage | MRR@5 | Recall@5 | Recall@10 | Hit@1 | Judged coverage @5 | Judged coverage @10 | Unjudged @5 | Unjudged @10 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| catalog::hybrid | hybrid | 0.518 | 0.545 | 0.909 | 0.364 | 1.000 | 0.917 | 0 | 10 |
| catalog::hybridGraphExpansion | hybrid | 0.518 | 0.545 | 0.909 | 0.364 | 0.950 | 0.850 | 3 | 18 |
| catalog::lexical | hybrid | 0.405 | 0.455 | 0.818 | 0.273 | 0.917 | 0.825 | 0 | 11 |
| catalog::semantic | hybrid | 0.182 | 0.136 | 0.136 | 0.182 | 0.167 | 0.167 | 0 | 0 |
| dispatch::hybrid | hybrid | 1.000 | 0.764 | 0.871 | 1.000 | 0.920 | 0.943 | 2 | 2 |
| dispatch::hybridGraphExpansion | hybrid | 1.000 | 0.764 | 0.871 | 1.000 | 0.840 | 0.750 | 4 | 9 |
| dispatch::lexical | hybrid | 1.000 | 0.684 | 0.791 | 1.000 | 0.920 | 0.943 | 2 | 2 |
| dispatch::semantic | hybrid | 0.600 | 0.220 | 0.220 | 0.600 | 0.600 | 0.600 | 0 | 0 |
| dynamic-registry::hybrid | hybrid | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 |
| dynamic-registry::hybridGraphExpansion | hybrid | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 |
| dynamic-registry::lexical | hybrid | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 |
| dynamic-registry::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| pricing::hybrid | hybrid | 0.854 | 0.823 | 0.938 | 0.750 | 1.000 | 1.000 | 0 | 0 |
| pricing::hybridGraphExpansion | hybrid | 0.854 | 0.823 | 0.938 | 0.750 | 1.000 | 1.000 | 0 | 0 |
| pricing::lexical | hybrid | 0.854 | 0.823 | 0.938 | 0.750 | 1.000 | 1.000 | 0 | 0 |
| pricing::semantic | hybrid | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 |
| workflow::hybrid | hybrid | 0.458 | 0.450 | 0.928 | 0.083 | 1.000 | 0.975 | 0 | 3 |
| workflow::hybridGraphExpansion | hybrid | 0.458 | 0.450 | 0.928 | 0.083 | 1.000 | 0.967 | 0 | 4 |
| workflow::lexical | hybrid | 0.458 | 0.481 | 0.944 | 0.083 | 1.000 | 0.975 | 0 | 3 |
| workflow::semantic | hybrid | 0.167 | 0.075 | 0.075 | 0.167 | 0.167 | 0.167 | 0 | 0 |

## Semantic profile comparison

| Profile | MRR@5 | Recall@5 | Recall@10 |
| --- | ---: | ---: | ---: |
| enabled | 0.659 | 0.626 | 0.921 |
| disabled | 0.626 | 0.599 | 0.889 |
| unavailable | 0.626 | 0.599 | 0.889 |

## Semantic query styles

| Style | MRR@5 | Recall@5 | Recall@10 |
| --- | ---: | ---: | ---: |
| direct-synonym | 1.000 | 1.000 | 1.000 |
| weak-lexical-overlap | 1.000 | 1.000 | 1.000 |
| mixed | 1.000 | 0.500 | 0.833 |
| no-added-value | 0.500 | 0.500 | 1.000 |

## TaskContext coverage and budget efficiency

- TaskContext admitted relevant items: 38
- TaskContext missed relevant items: 1
- TaskContext admitted supporting items: 119
- TaskContext missed supporting items: 1
- Required/relevant subject coverage: 0.925
- Supporting subject coverage: 0.850
- Relevant coverage per 1,000 estimated tokens: 1.268
- Mean estimated tokens: 742.4

## Ambiguity outcomes

- false-promotion: 1
- incorrect-promotion: 3
- no-promotion-observed: 1

| Case | Expectation | Outcome | Top candidate |
| --- | --- | --- | --- |
| catalog-ambiguous-load | no-promotion | no-promotion-observed | ["symbol","catalog-cache.ts","class","CatalogCache"] |
| catalog-context-disambiguation | unique-promotion | incorrect-promotion | ["symbol","catalog-cache.ts","class","CatalogCache"] |
| pricing-ambiguous | no-promotion | false-promotion | ["symbol","orders.ts","function","findById"] |
| pricing-path-disambiguation | unique-promotion | incorrect-promotion | ["symbol","orders.ts","function","findById"] |
| workflow-ambiguous-run-task | unique-promotion | incorrect-promotion | ["symbol","queue.ts","function","queueTask"] |

## SCIP paired expansion

- catalog-implementation / parser-only: Recall@10 0.600
- catalog-implementation / scip-enriched: Recall@10 0.600
- catalog-cross-file / parser-only: Recall@10 0.000
- catalog-cross-file / scip-enriched: Recall@10 0.400
- registry-scip-cross-file / parser-only: Recall@10 0.333
- registry-scip-cross-file / scip-enriched: Recall@10 0.667
- workflow-implementation / parser-only: Recall@10 0.667
- workflow-implementation / scip-enriched: Recall@10 0.667
- workflow-scip-cross-file / parser-only: Recall@10 0.000
- workflow-scip-cross-file / scip-enriched: Recall@10 0.333

## Unresolved judgment queue

- Remaining hybrid unjudged appearances: @5 2; @10 15

| Priority | Case | Family | Split | Query class | Query | Candidate | Source ranks | Appearances |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| top5 | dispatch-caller | dispatch | development | caller | searchStore callers in the request path | ["symbol","search-store.js","function","arrow_function@180"] | hybrid#5 | 2 |
| top5 | dispatch-graph-dependent | dispatch | development | graph-dependent | routeSearch | ["symbol","search-store.js","function","arrow_function@180"] | hybrid#5 | 2 |
| recurring | catalog-callee | catalog | held-out | callee | browseCatalog repository call | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9 | 10 |
| recurring | catalog-caller | catalog | held-out | caller | getCatalogItem callers | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9 | 10 |
| recurring | catalog-context-disambiguation | catalog | held-out | ambiguous | CatalogCache load | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9 | 10 |
| recurring | catalog-cross-file | catalog | held-out | cross-file | catalog browsing delegates item retrieval | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9 | 10 |
| recurring | catalog-exact-symbol | catalog | held-out | exact-symbol | getCatalogItem | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9 | 10 |
| recurring | catalog-graph-dependent | catalog | held-out | graph-dependent | browseCatalog expands to repository lookup | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9 | 10 |
| recurring | catalog-implementation | catalog | held-out | implementation-discovery | CatalogStore implementation | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9, scip-enriched#4, scip-parser-only#4 | 10 |
| recurring | catalog-lexical-only | catalog | held-out | lexical-only | CatalogCache clear | ["symbol","repository.ts","function","getCatalogItemMetadata"] | hybrid#9 | 10 |
| recurring | catalog-semantic-disabled | catalog | held-out | semantic-disabled | catalog title search | ["symbol","repository.ts","function","getCatalogItemMetadata"] | semantic-lexical#9 | 10 |
| recurring | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["symbol","repository.ts","function","getCatalogItemMetadata"] | graph-expansion-only#9 | 10 |
| recurring | dispatch-caller | dispatch | development | caller | searchStore callers in the request path | ["file","text-utils.js"] | task-context#3 | 4 |
| recurring | dispatch-semantic-disabled | dispatch | development | semantic-disabled | canonicalize whitespace and lowercase a request before searching | ["file","text-utils.js"] | graph-expansion-only#5 | 4 |
| recurring | dispatch-semantic-paraphrase | dispatch | development | semantic-paraphrase | canonicalize whitespace and lowercase a request before searching | ["file","text-utils.js"] | graph-expansion-only#9 | 4 |
| recurring | dispatch-semantic-unavailable | dispatch | development | semantic-unavailable | canonicalize whitespace and lowercase a request before searching | ["file","text-utils.js"] | graph-expansion-only#5 | 4 |
| recurring | catalog-cross-file | catalog | held-out | cross-file | catalog browsing delegates item retrieval | ["file","catalog-flow.ts"] | scip-enriched#2, scip-parser-only#1 | 3 |
| recurring | catalog-cross-file | catalog | held-out | cross-file | catalog browsing delegates item retrieval | ["file","repository.ts"] | scip-enriched#3, scip-parser-only#4 | 3 |
| recurring | catalog-implementation | catalog | held-out | implementation-discovery | CatalogStore implementation | ["file","catalog-flow.ts"] | scip-enriched#6, scip-parser-only#6 | 3 |
| recurring | catalog-implementation | catalog | held-out | implementation-discovery | CatalogStore implementation | ["file","repository.ts"] | scip-enriched#1, scip-parser-only#1 | 3 |
| recurring | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["file","catalog-flow.ts"] | graph-expansion-only#3 | 3 |
| recurring | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["file","repository.ts"] | graph-expansion-only#4 | 3 |
| recurring | dispatch-semantic-disabled | dispatch | development | semantic-disabled | canonicalize whitespace and lowercase a request before searching | ["file","router.js"] | graph-expansion-only#6 | 3 |
| recurring | dispatch-semantic-paraphrase | dispatch | development | semantic-paraphrase | canonicalize whitespace and lowercase a request before searching | ["file","router.js"] | graph-expansion-only#7 | 3 |
| recurring | dispatch-semantic-unavailable | dispatch | development | semantic-unavailable | canonicalize whitespace and lowercase a request before searching | ["file","router.js"] | graph-expansion-only#6 | 3 |
| recurring | workflow-implementation | workflow | held-out | implementation-discovery | TaskPolicy implementation | ["file","queue.ts"] | scip-enriched#7, scip-parser-only#7 | 3 |
| recurring | workflow-implementation | workflow | held-out | implementation-discovery | TaskPolicy implementation | ["file","task.ts"] | scip-enriched#1, scip-parser-only#1 | 3 |
| recurring | workflow-natural-language | workflow | held-out | natural-language | where is a failed workflow step retried | ["file","task.ts"] | task-context#3 | 3 |
| recurring | workflow-scip-cross-file | workflow | held-out | scip-improved-cross-file | submitWorkflow calls executeTask | ["file","queue.ts"] | scip-enriched#2, scip-parser-only#1 | 3 |
| recurring | workflow-scip-cross-file | workflow | held-out | scip-improved-cross-file | submitWorkflow calls executeTask | ["file","task.ts"] | scip-enriched#3, scip-parser-only#3 | 3 |
| recurring | workflow-semantic-mixed | workflow | held-out | semantic-paraphrase | complete a work unit only after policy validation | ["file","queue.ts"] | graph-expansion-only#10 | 3 |
| recurring | catalog-context-disambiguation | catalog | held-out | ambiguous | CatalogCache load | ["symbol","repository.ts","function","getCatalogItem"] | hybrid#8 | 2 |
| recurring | catalog-lexical-only | catalog | held-out | lexical-only | CatalogCache clear | ["symbol","repository.ts","function","getCatalogItem"] | hybrid#8 | 2 |
| recurring | workflow-exact-symbol | workflow | held-out | exact-symbol | runTask | ["symbol","task.ts","function","runTaskWithPolicy"] | hybrid#7 | 2 |
| recurring | workflow-semantic-unavailable | workflow | held-out | semantic-unavailable | complete a task through its validation policy | ["symbol","task.ts","function","runTaskWithPolicy"] | hybrid#9, semantic-lexical#7 | 2 |
| top10 | workflow-semantic-unavailable | workflow | held-out | semantic-unavailable | complete a task through its validation policy | ["symbol","task.ts","function","runTask"] | hybrid#8, semantic-lexical#6 | 1 |
| held-out | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["symbol","catalog-flow.ts","function","arrow_function@322"] | graph-expansion-only#6 | 1 |
| held-out | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["symbol","catalog-flow.ts","function","searchCatalogTitles"] | graph-expansion-only#7 | 1 |
| held-out | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["symbol","repository.ts","class","MemoryCatalogStore"] | graph-expansion-only#8 | 1 |
| held-out | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["symbol","repository.ts","interface","CatalogStore"] | graph-expansion-only#5 | 1 |
| held-out | catalog-semantic-synonym | catalog | held-out | semantic-paraphrase | retrieve a product record from its identifier | ["symbol","repository.ts","method","load"] | graph-expansion-only#10 | 1 |
| held-out | registry-scip-cross-file | dynamic-registry | held-out | scip-improved-cross-file | exportReport | ["file","exporter.ts"] | scip-enriched#2, scip-parser-only#1 | 1 |
| held-out | registry-scip-cross-file | dynamic-registry | held-out | scip-improved-cross-file | exportReport | ["file","report.ts"] | scip-enriched#3 | 1 |
| graph-expansion-only | dispatch-semantic-paraphrase | dispatch | development | semantic-paraphrase | canonicalize whitespace and lowercase a request before searching | ["file","search-store.js"] | graph-expansion-only#8 | 1 |

## Source contribution (candidate appearances by stage)

- graphLookup: graph 14
- hybrid: lexical 287, vector 14
- hybridGraphExpansion: graph 43, lexical 287, vector 14
- lexical: lexical 287
- semantic: vector 14
- taskContext: taskContext 116

Candidate report only. Promote to the frozen baseline only after explicit review.
