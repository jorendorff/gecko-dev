/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Implements sequential traversal over the DOM tree.

#![deny(missing_docs)]

use dom::{TElement, TNode};
use std::borrow::BorrowMut;
use std::collections::VecDeque;
use time;
use traversal::{DomTraversal, PerLevelTraversalData, PreTraverseToken};

struct WorkItem<N: TNode>(N, usize);

/// Do a sequential DOM traversal for layout or styling, generic over `D`.
pub fn traverse_dom<E, D>(traversal: &D,
                          root: E,
                          token: PreTraverseToken)
    where E: TElement,
          D: DomTraversal<E>,
{
    let dump_stats = traversal.shared_context().options.dump_style_statistics;
    let start_time = if dump_stats { Some(time::precise_time_s()) } else { None };

    debug_assert!(!traversal.is_parallel());
    debug_assert!(token.should_traverse());

    let mut discovered = VecDeque::<WorkItem<E::ConcreteNode>>::with_capacity(16);
    let mut tlc = traversal.create_thread_local_context();
    let root_depth = root.depth();

    if token.traverse_unstyled_children_only() {
        for kid in root.as_node().children() {
            if kid.as_element().map_or(false, |el| el.get_data().is_none()) {
                discovered.push_back(WorkItem(kid, root_depth + 1));
            }
        }
    } else {
        discovered.push_back(WorkItem(root.as_node(), root_depth));
    }

    // Process the nodes breadth-first, just like the parallel traversal does.
    // This helps keep similar traversal characteristics for the style sharing
    // cache.
    while let Some(WorkItem(node, depth)) = discovered.pop_front() {
        let mut children_to_process = 0isize;
        let traversal_data = PerLevelTraversalData { current_dom_depth: depth };
        traversal.process_preorder(&traversal_data, &mut tlc, node);

        if let Some(el) = node.as_element() {
            traversal.traverse_children(&mut tlc, el, |_tlc, kid| {
                children_to_process += 1;
                discovered.push_back(WorkItem(kid, depth + 1))
            });
        }

        traversal.handle_postorder_traversal(&mut tlc, root.as_node().opaque(),
                                             node, children_to_process);
    }

    // Dump statistics to stdout if requested.
    if dump_stats {
        let tlsc = tlc.borrow_mut();
        tlsc.statistics.finish(traversal, start_time.unwrap());
        println!("{}", tlsc.statistics);
    }
}
