/*! TimelineAnimation · UI LAYOUT · MIT · see LICENSE and SOURCE.md. */
import {motion,useInView,useReducedMotion} from 'motion/react';

export function TimelineAnimation({children,animationNum,timelineRef,className,reduceMotion=false}) {
  const isInView=useInView(timelineRef,{once:true}),systemReduced=useReducedMotion(),reduced=reduceMotion||systemReduced;
  // Keep useful content visible on the first frame; no multi-second blur sequence in a feed.
  return <motion.div initial={false} animate={{opacity:1,y:0}} whileHover={reduced?undefined:{y:-1}} transition={{duration:reduced?0:.16,delay:isInView?0:Math.min(animationNum*.015,.08)}} className={className}>{children}</motion.div>;
}
