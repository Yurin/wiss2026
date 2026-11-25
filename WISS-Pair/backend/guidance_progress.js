function compareGuidance(previous, current) {
  if (!previous || previous.guideId !== current.guideId ||
      JSON.stringify(previous.guidanceConfig) !== JSON.stringify(current.guidanceConfig) ||
      JSON.stringify(previous.guideTransform) !== JSON.stringify(current.guideTransform) ||
      !Number.isSafeInteger(current.captureSequence) || !Number.isSafeInteger(previous.captureSequence) ||
      current.captureSequence <= previous.captureSequence) return [];
  const prior = new Map((previous.guidanceCandidates || []).map((c) => [c.candidateId, c]));
  const selected = new Set((previous.selectedGuidance || []).map((c) => c.candidateId));
  return (current.guidanceCandidates || []).filter((c) => prior.has(c.candidateId)).map((c) => {
    const old = prior.get(c.candidateId);
    const known = Number.isFinite(old.errorMagnitude) && Number.isFinite(c.errorMagnitude);
    return { candidateId: c.candidateId, targetRole: c.targetRole, guidanceCategory: c.category,
      previousAnalysisId: previous.analysisId, analysisId: current.analysisId,
      previousCaptureSequence: previous.captureSequence, captureSequence: current.captureSequence,
      wasSelected: selected.has(c.candidateId), beforeError: old.errorMagnitude, afterError: c.errorMagnitude,
      improvement: known ? old.errorMagnitude - c.errorMagnitude : null,
      improved: known ? c.errorMagnitude < old.errorMagnitude : null,
      status: c.status, resolved: c.isResolved, newlyResolved: !old.isResolved && c.isResolved,
      regressed: known && old.isResolved && !c.isResolved,
      captureIntervalMs: Number.isFinite(current.captureTimestamp) && Number.isFinite(previous.captureTimestamp)
        ? current.captureTimestamp - previous.captureTimestamp : null };
  });
}
module.exports = { compareGuidance };
