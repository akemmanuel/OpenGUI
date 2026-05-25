export type ModelSearchCandidate = {
  value: string;
  providerID: string;
  modelID: string;
  providerName: string;
  label: string;
};

export function normalizeModelQuery(text: string) {
  return text.trim().toLowerCase();
}

export function buildModelSearchText(model: ModelSearchCandidate) {
  return normalizeModelQuery(
    `${model.modelID} ${model.providerID} ${model.providerID}/${model.modelID} ${model.providerName} ${model.label} ${model.providerID} ${model.modelID}`,
  );
}

export function findExactModelReferenceMatch<T extends ModelSearchCandidate>(
  modelReference: string,
  availableModels: readonly T[],
) {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) {
    return undefined;
  }

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => `${model.providerID}/${model.modelID}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) {
    return canonicalMatches[0];
  }
  if (canonicalMatches.length > 1) {
    return undefined;
  }

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelID = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelID) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.providerID.toLowerCase() === provider.toLowerCase() &&
          model.modelID.toLowerCase() === modelID.toLowerCase(),
      );
      if (providerMatches.length === 1) {
        return providerMatches[0];
      }
      if (providerMatches.length > 1) {
        return undefined;
      }
    }
  }

  const idMatches = availableModels.filter(
    (model) => model.modelID.toLowerCase() === normalizedReference,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

export type FuzzyMatch = {
  matches: boolean;
  score: number;
};

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const matchQuery = (normalizedQuery: string): FuzzyMatch => {
    if (normalizedQuery.length === 0) {
      return { matches: true, score: 0 };
    }
    if (normalizedQuery.length > textLower.length) {
      return { matches: false, score: 0 };
    }

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;

    for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
      if (textLower[i] === normalizedQuery[queryIndex]) {
        const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1] ?? "");

        if (lastMatchIndex === i - 1) {
          consecutiveMatches++;
          score -= consecutiveMatches * 5;
        } else {
          consecutiveMatches = 0;
          if (lastMatchIndex >= 0) {
            score += (i - lastMatchIndex - 1) * 2;
          }
        }

        if (isWordBoundary) {
          score -= 10;
        }

        score += i * 0.1;
        lastMatchIndex = i;
        queryIndex++;
      }
    }

    if (queryIndex < normalizedQuery.length) {
      return { matches: false, score: 0 };
    }

    if (normalizedQuery === textLower) {
      score -= 100;
    }

    return { matches: true, score };
  };

  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) {
    return primaryMatch;
  }

  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
      : "";

  if (!swappedQuery) {
    return primaryMatch;
  }

  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) {
    return primaryMatch;
  }

  return { matches: true, score: swappedMatch.score + 5 };
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query.trim()) {
    return [...items];
  }

  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return [...items];
  }

  const results: { item: T; totalScore: number }[] = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;

    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (match.matches) {
        totalScore += match.score;
      } else {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      results.push({ item, totalScore });
    }
  }

  results.sort((a, b) => a.totalScore - b.totalScore);
  return results.map((result) => result.item);
}

export function filterModelSearchCandidates<T extends ModelSearchCandidate>(
  models: readonly T[],
  query: string,
) {
  return fuzzyFilter(models, query, buildModelSearchText);
}
