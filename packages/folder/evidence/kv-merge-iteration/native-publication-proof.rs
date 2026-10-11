
#[test]
fn kv_iteration_an_index_failure_leaves_landed_bytes_without_incoming_ancestry() {
    let incoming = incoming("kv-index-failure-proof");
    let original = git(&incoming.root, &["rev-parse", "HEAD"]);
    std::fs::write(incoming.upstream.join("notes.md"), "incoming bytes").unwrap();
    let fetched = incoming.publish("incoming change");
    let index_lock = incoming.root.join(".git/index.lock");
    std::fs::write(&index_lock, "held by the proof").unwrap();
    let outcome = incoming.owner.pull_fast_forward();
    assert!(matches!(outcome, Err(PullError::IndexFailed { .. })), "{outcome:?}");
    assert_eq!(git(&incoming.root, &["rev-parse", "HEAD"]), original);
    assert_eq!(std::fs::read_to_string(incoming.root.join("notes.md")).unwrap(), "incoming bytes");
    std::fs::remove_file(index_lock).unwrap();
    let checkpoint = incoming.owner.commit();
    assert!(matches!(checkpoint, CommitOutcome::Committed { .. }), "{checkpoint:?}");
    assert_eq!(git(&incoming.root, &["log", "-1", "--format=%P"]), original);
    assert_ne!(git(&incoming.root, &["rev-parse", "HEAD"]), fetched);
    incoming.owner.shutdown();
}
